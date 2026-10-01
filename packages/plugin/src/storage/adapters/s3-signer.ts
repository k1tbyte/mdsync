import { toHex } from "@obsync/protocol";

import { sha256Hex } from "@/crypto";
import type { S3StorageConfig } from "@/storage/config";

/**
 * SigV4 signing for S3-compatible storage, so requests go through Obsidian's `requestUrl` instead of
 * `fetch`: at origin `app://obsidian.md` fetch is subject to CORS, which most backends reject until the
 * user hand-writes a bucket CORS policy.
 */
const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";

/** SHA-256 of the empty string: the payload hash of a request with no body. */
const EMPTY_PAYLOAD_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Hashing an upload is a second full pass over every blob on the UI thread. Over HTTPS TLS protects the
 * body and AWS documents this option; a plain-HTTP endpoint (a LAN MinIO) has no transport integrity, so
 * there the body is hashed.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const AWS_DEFAULT_REGION = "us-east-1";

const encoder = new TextEncoder();

export type S3Method = "GET" | "PUT" | "HEAD" | "DELETE";

export interface S3RequestInput {
	method: S3Method;
	/** Bucket-relative key. Empty addresses the bucket itself, for a listing. */
	key: string;
	query?: Record<string, string>;
	headers?: Record<string, string>;
	/** Hashed only when the endpoint is not HTTPS; see {@link UNSIGNED_PAYLOAD}. */
	body?: Uint8Array;
}

export interface SignedRequest {
	url: string;
	/** Ready to hand to `requestUrl`; `host` is left to the transport. */
	headers: Record<string, string>;
}

export type S3Signer = (input: S3RequestInput) => Promise<SignedRequest>;

export function createS3Signer(config: S3StorageConfig): S3Signer {
	const endpoint = resolveEndpoint(config);
	const region = signingRegion(config);
	// Derived signing keys are stable per (secret, day, region); a push signs one request per object.
	let cached: { dateStamp: string; key: CryptoKey } | null = null;

	const signingKey = async (dateStamp: string): Promise<CryptoKey> => {
		if (cached?.dateStamp === dateStamp) return cached.key;
		let key = await importHmacKey(
			encoder.encode(`AWS4${config.secretAccessKey}`),
		);
		for (const part of [dateStamp, region, SERVICE, "aws4_request"]) {
			key = await importHmacKey(await hmac(key, part));
		}
		cached = { dateStamp, key };
		return key;
	};

	return async (input) => {
		const canonicalUri = objectUri(config, endpoint.basePath, input.key);
		const canonicalQuery = canonicalizeQuery(input.query ?? {});
		const payloadHash = await payloadDigest(input.body, endpoint.protocol);
		const amzDate = timestamp();
		const dateStamp = amzDate.slice(0, 8);

		const signed: Record<string, string> = { host: endpoint.host };
		for (const [name, value] of Object.entries(input.headers ?? {})) {
			// SigV4 canonicalises a header value by trimming it and collapsing internal whitespace runs to one space.
			signed[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
		}
		signed["x-amz-content-sha256"] = payloadHash;
		signed["x-amz-date"] = amzDate;

		const names = Object.keys(signed).sort();
		const canonicalHeaders = names
			.map((name) => `${name}:${signed[name] ?? ""}\n`)
			.join("");
		const signedHeaders = names.join(";");

		const canonicalRequest = [
			input.method,
			canonicalUri,
			canonicalQuery,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join("\n");

		const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
		const stringToSign = [
			ALGORITHM,
			amzDate,
			scope,
			await sha256Hex(encoder.encode(canonicalRequest)),
		].join("\n");
		const signature = toHex(
			await hmac(await signingKey(dateStamp), stringToSign),
		);

		return {
			url: `${endpoint.protocol}//${endpoint.host}${canonicalUri}${
				canonicalQuery ? `?${canonicalQuery}` : ""
			}`,
			headers: {
				...(input.headers ?? {}),
				"x-amz-content-sha256": payloadHash,
				"x-amz-date": amzDate,
				Authorization:
					`${ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
					`SignedHeaders=${signedHeaders}, Signature=${signature}`,
			},
		};
	};
}

interface ResolvedEndpoint {
	protocol: string;
	host: string;
	/** Path the endpoint itself sits under, ahead of the bucket. */
	basePath: string;
}

/**
 * The default region "auto" is accepted by R2 but not AWS: with no endpoint it would name the host
 * `s3.auto.amazonaws.com`, which resolves nowhere. us-east-1 instead fails with a 400 naming the bucket's
 * real region, which the user can act on.
 */
export function signingRegion(config: S3StorageConfig): string {
	const region = config.region.trim();
	if (!region) return AWS_DEFAULT_REGION;
	if (!config.endpoint.trim() && region === "auto") return AWS_DEFAULT_REGION;
	return region;
}

/** The endpoint as a full URL; empty means AWS itself. */
export function endpointUrl(config: S3StorageConfig): string {
	const raw = config.endpoint.trim();
	if (!raw) return `https://s3.${signingRegion(config)}.amazonaws.com`;
	return raw.includes("://") ? raw : `https://${raw}`;
}

function resolveEndpoint(config: S3StorageConfig): ResolvedEndpoint {
	const url = new URL(endpointUrl(config));
	// Only the hostname is lowercased: a capitalised bucket is still itself in a path-style URI, but the
	// transport sends a lowercased Host, which would not match the signature.
	const host = config.forcePathStyle
		? url.host
		: `${config.bucket}.${url.host}`;
	return {
		protocol: url.protocol,
		host: host.toLowerCase(),
		basePath: decodePath(url.pathname.replace(/\/+$/, "")),
	};
}

async function payloadDigest(
	body: Uint8Array | undefined,
	protocol: string,
): Promise<string> {
	if (!body) return EMPTY_PAYLOAD_SHA256;
	if (protocol === "https:") return UNSIGNED_PAYLOAD;
	return sha256Hex(body);
}

/**
 * A bucket-level call has no key: its URI is the bucket itself, and a trailing slash would sign a path S3
 * does not resolve to it.
 */
function objectUri(
	config: S3StorageConfig,
	basePath: string,
	key: string,
): string {
	const path = config.forcePathStyle
		? key
			? `/${config.bucket}/${key}`
			: `/${config.bucket}`
		: `/${key}`;
	return encodePath(`${basePath}${path}`) || "/";
}

function canonicalizeQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] ?? "")}`)
		.join("&");
}

/** `20260907T101530Z`, the only format SigV4 accepts. */
function timestamp(): string {
	return new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}/, "");
}

function importHmacKey(raw: BufferSource): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		raw,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function hmac(key: CryptoKey, data: string): Promise<ArrayBuffer> {
	return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

/** `encodeURIComponent` leaves these, and SigV4 requires them encoded. */
function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Percent-encodes each path segment, leaving the separators intact. */
function encodePath(path: string): string {
	return path.split("/").map(encodeRfc3986).join("/");
}

function decodePath(path: string): string {
	return path
		.split("/")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/");
}
