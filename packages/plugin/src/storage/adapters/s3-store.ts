import { requestUrl } from "obsidian";

import {
	type ConditionalRead,
	type StorageAdapter,
	StorageRequestError,
} from "@/storage/types";
import { toArrayBuffer } from "@/utils/bytes";

import type { S3RequestInput, S3Signer } from "./s3-signer";
import { parseErrorCode, parseListObjects } from "./s3-xml";
import {
	assertOk,
	headerValue,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

const HTTP_NOT_FOUND = 404;
const HTTP_NOT_MODIFIED = 304;
const HTTP_PRECONDITION_FAILED = 412;
/** Stored with every object, as the SDK adapter did. */
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

/** The S3 object protocol: absence, revalidation, conditional writes, paged listings. */
export function createS3Store(transport: S3Transport): StorageAdapter {
	const send = createSender(transport.sign);

	const readObject = async (
		key: string,
		etag: string | null,
	): Promise<ConditionalRead> => {
		const res = await send({
			method: "GET",
			key: transport.key(key),
			// The manifest moves under us, and a revalidated read is what the
			// stale-read reconciliation in sync/manifest.ts assumes.
			headers: {
				"Cache-Control": "no-cache",
				...(etag ? { "If-None-Match": etag } : {}),
			},
		});
		if (res.status === HTTP_NOT_MODIFIED) {
			// Only ever an answer about the validator we sent. Unsolicited it
			// describes nothing, and the caller of a plain read would take it for
			// an object that is not there.
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
			return parseListObjects(res.text).keys.some(
				(listed) => transport.relative(listed) === key,
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
			// S3 answers 204 for a key that was never there; a backend that
			// answers 404 means the same thing.
			if (isAbsent(res)) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			const keys: string[] = [];
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
				for (const key of page.keys) {
					const relative = transport.relative(key);
					// A folder marker under the prefix relativises to "", which is not
					// an object any caller can ask for.
					if (relative) keys.push(relative);
				}
				token = page.nextToken;
				// A backend that hands back a token it already gave would keep the
				// listing going forever. Stopping would answer with a partial list,
				// which is what decides whether an object gets deleted.
				if (token && seenTokens.has(token)) {
					throw new Error(
						`S3 repeated a continuation token while listing "${keyPrefix}", so the object list cannot be completed.`,
					);
				}
				if (token) seenTokens.add(token);
			} while (token);
			return keys;
		},
	};
}

type S3Response = Awaited<ReturnType<typeof requestUrl>>;
type Send = (input: S3RequestInput, body?: Uint8Array) => Promise<S3Response>;

/**
 * Signs and sends under the shared timeout and retry policy. Signing happens
 * inside the retry, not once around it: a signature carries the minute it was
 * made and a request replayed after a backoff would be refused for skew.
 */
function createSender(sign: S3Signer): Send {
	return async (input, body) => {
		try {
			return await withRetry(async () => {
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
				if (isRetryableStatus(res.status)) {
					throw new StorageHttpError(
						res.status,
						`S3 request failed (HTTP ${res.status})`,
					);
				}
				return res;
			});
		} catch (error) {
			throw contextualRequestError(error, input);
		}
	};
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
	Object.setPrototypeOf(contextual, Object.getPrototypeOf(error));
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
 * A 404 usually means the object is not there. NoSuchBucket is also a 404, but
 * it means the configuration is wrong, not that the vault is empty - reporting
 * it as absence would re-upload everything into nowhere, and an empty manifest
 * read as the remote head would republish over the real one.
 *
 * A body that is not an S3 error document is something between the plugin and
 * the bucket answering: a proxy or a captive portal, not the bucket saying the
 * object is gone. Some backends omit the body on an object 404, so a silent
 * 404 remains ambiguous.
 */
function isAbsent(res: S3Response): boolean {
	if (res.status !== HTTP_NOT_FOUND) return false;
	const code = parseErrorCode(res.text);
	if (code === "NoSuchBucket") return false;
	return code !== null || res.text.trim() === "";
}
