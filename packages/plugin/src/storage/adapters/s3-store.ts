import { requestUrl } from "obsidian";

import {
	type ConditionalRead,
	type ListedObject,
	type StorageAdapter,
	StorageRequestError,
} from "@/storage/types";
import { toArrayBuffer } from "@/utils";

import type { S3RequestInput, S3Signer } from "./s3-signer";
import { parseErrorCode, parseListObjects } from "./s3-xml";
import {
	assertOk,
	headerValue,
	isRetryableError,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

const HTTP_NOT_FOUND = 404;
const HTTP_NOT_MODIFIED = 304;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_CONFLICT = 409;
const OBJECT_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

/** Where S3 requests go: straight to the bucket, or through the relay's share broker. */
export interface S3Transport {
	identity: string;
	sign: S3Signer;
	/** The caller's key as `sign` takes it. */
	key(key: string): string;
	/** A listed key back to the caller's; "" for a folder marker. */
	relative(listed: string): string;
}

export function createS3Store(transport: S3Transport): StorageAdapter {
	const send = createSender(transport.sign);

	const readObject = async (
		key: string,
		etag: string | null,
	): Promise<ConditionalRead> => {
		const res = await send({
			method: "GET",
			key: transport.key(key),
			// The manifest moves under us, and a revalidated read is what the stale-read reconciliation in
			// sync/manifest.ts assumes.
			headers: {
				"Cache-Control": "no-cache",
				...(etag ? { "If-None-Match": etag } : {}),
			},
		});
		if (res.status === HTTP_NOT_MODIFIED) {
			// Only ever an answer about the validator we sent: unsolicited it describes nothing, and a
			// plain read's caller would take it for an absent object.
			if (!etag) {
				throw new Error(
					`S3 answered 304 to an unconditional read of "${key}".`,
				);
			}
			return { status: "unchanged" };
		}
		if (isAbsent(res)) return { status: "absent" };
		assertOk(res, "read", key);
		return {
			status: "found",
			body: new Uint8Array(res.arrayBuffer),
			etag: headerValue(res.headers, "etag"),
		};
	};

	const listObjects = async (keyPrefix: string): Promise<ListedObject[]> => {
		const objects: ListedObject[] = [];
		const seenTokens = new Set<string>();
		let token: string | undefined;
		do {
			const query: Record<string, string> = {
				"list-type": "2",
				prefix: transport.key(keyPrefix),
			};
			if (token) query["continuation-token"] = token;
			// A listing addresses the bucket itself, so it carries no key.
			const res = await send({ method: "GET", key: "", query });
			assertOk(res, "list", keyPrefix);
			const page = parseListObjects(res.text);
			for (const object of page.objects) {
				const relative = transport.relative(object.key);
				// A folder marker under the prefix relativises to "", which no caller can ask for.
				if (relative) objects.push({ ...object, key: relative });
			}
			token = page.nextToken;
			// A repeated token would loop forever, and stopping would return a partial list, which decides
			// whether an object gets deleted.
			if (token && seenTokens.has(token)) {
				throw new Error(
					`S3 repeated a continuation token while listing "${keyPrefix}", so the object list cannot be completed.`,
				);
			}
			if (token) seenTokens.add(token);
		} while (token);
		return objects;
	};

	return {
		identity() {
			return transport.identity;
		},
		async exists(key) {
			const res = await send({
				method: "GET",
				key: "",
				query: {
					"list-type": "2",
					prefix: transport.key(key),
					"max-keys": "1",
				},
			});
			if (
				res.status === 403 &&
				parseErrorCode(res.text) === "SignatureDoesNotMatch"
			) {
				throw new StorageRequestError(
					`S3 existence check for "${key}" failed: SignatureDoesNotMatch (HTTP 403)`,
					"S3 rejected the request signature. Check the secret access key or re-import the storage settings.",
				);
			}
			assertOk(res, "check", key);
			return parseListObjects(res.text).objects.some(
				(listed) => transport.relative(listed.key) === key,
			);
		},
		async get(key) {
			const read = await readObject(key, null);
			return read.status === "found" ? read.body : null;
		},
		getIfChanged: readObject,
		async put(key, body, contentType) {
			const res = await sendPut(send, transport.key(key), body, contentType);
			assertOk(res, "write", key);
		},
		async putIfAbsent(key, body, contentType) {
			const res = await sendPut(send, transport.key(key), body, contentType, {
				"If-None-Match": "*",
			});
			if (res.status === HTTP_PRECONDITION_FAILED) return false;
			assertOk(res, "write", key);
			return true;
		},
		async delete(key) {
			const res = await send({ method: "DELETE", key: transport.key(key) });
			// S3 answers 204 for a key that was never there; a backend answering 404 means the same.
			if (isAbsent(res)) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			return (await listObjects(keyPrefix)).map((object) => object.key);
		},
		listDetailed: listObjects,
	};
}

type S3Response = Awaited<ReturnType<typeof requestUrl>>;
type Send = (input: S3RequestInput, body?: Uint8Array) => Promise<S3Response>;

/**
 * Signs and sends under the shared timeout and retry policy. Signing happens inside the retry: a signature
 * carries the minute it was made, and a request replayed after a backoff would be refused for skew.
 */
function createSender(sign: S3Signer): Send {
	return async (input, body) => {
		try {
			return await withRetry(
				async () => {
					const signed = await sign({ ...input, body });
					const res = await withTimeout(
						requestUrl({
							url: signed.url,
							method: input.method,
							headers: signed.headers,
							...(body ? { body: toArrayBuffer(body) } : {}),
							throw: false,
						}),
						STORAGE_TIMEOUT_MS,
					);
					if (isRetryableStatus(res.status) || isRacing(input, res.status)) {
						throw new StorageHttpError(
							res.status,
							`S3 request failed (HTTP ${res.status})`,
						);
					}
					return res;
				},
				(err) => isRetryableError(err) || isRacingError(input, err),
			);
		} catch (error) {
			throw contextualRequestError(error, input);
		}
	};
}

/** 409 on a conditional write: another one is in flight, and a retry sees who won. */
function isRacing(input: S3RequestInput, status: number): boolean {
	return (
		status === HTTP_CONFLICT && input.headers?.["If-None-Match"] !== undefined
	);
}

function isRacingError(input: S3RequestInput, err: unknown): boolean {
	return err instanceof StorageHttpError && isRacing(input, err.status);
}

function contextualRequestError(
	error: unknown,
	input: S3RequestInput,
): unknown {
	if (!(error instanceof Error)) return error;
	const target = input.key ? `"${input.key}"` : "listing";
	const message = `S3 ${input.method} to ${target} failed: ${error.message}`;
	if (/stream closed|unknown\s*host(?:exception)?/i.test(error.message)) {
		return new StorageRequestError(
			message,
			"S3 request failed on this device. Check the connection and try again. See Obsync logs for details.",
		);
	}
	if (error instanceof StorageHttpError) {
		return new StorageHttpError(error.status, message);
	}
	if (typeof DOMException !== "undefined" && error instanceof DOMException) {
		return new DOMException(message, error.name);
	}
	const contextual = new Error(message);
	contextual.name = error.name;
	Object.setPrototypeOf(
		contextual,
		Object.getPrototypeOf(error) as object | null,
	);
	Object.assign(contextual, error);
	return contextual;
}

function sendPut(
	send: Send,
	key: string,
	body: Uint8Array,
	contentType: string | undefined,
	extraHeaders: Record<string, string> = {},
): Promise<S3Response> {
	return send(
		{
			method: "PUT",
			key,
			headers: {
				"Content-Type": contentType ?? "application/octet-stream",
				"Cache-Control": OBJECT_CACHE_CONTROL,
				...extraHeaders,
			},
		},
		body,
	);
}

/**
 * A 404 is absence, except NoSuchBucket (wrong configuration: absence would re-upload everything and
 * republish an empty manifest over the real head) or a body that is no S3 error document (a proxy or
 * captive portal). Some backends omit the body on an object 404, so a silent 404 stays ambiguous.
 */
function isAbsent(res: S3Response): boolean {
	if (res.status !== HTTP_NOT_FOUND) return false;
	const code = parseErrorCode(res.text);
	if (code === "NoSuchBucket") return false;
	return code !== null || res.text.trim() === "";
}
