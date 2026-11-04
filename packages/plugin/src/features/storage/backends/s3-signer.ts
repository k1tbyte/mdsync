import {
	amzTimestamp,
	canonicalizeQuery,
	decodePath,
	deriveSigningKey,
	encodePath,
	hmac,
	SIGV4_ALGORITHM,
	SIGV4_SERVICE,
	toHex,
	UNSIGNED_PAYLOAD,
} from "@mdsync/protocol";

import { sha256Hex } from "@/core/crypto";
import type { S3StorageConfig } from "../config";

/**
 * SigV4 lets S3-compatible requests use Obsidian's `requestUrl`, not `fetch`: at `app://obsidian.md`,
 * fetch faces CORS, which most backends reject without a hand-written bucket CORS policy.
 */

/** SHA-256 of the empty string: the payload hash of a request with no body. */
const EMPTY_PAYLOAD_SHA256 =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

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
		const key = await deriveSigningKey(
			config.secretAccessKey,
			dateStamp,
			region,
		);
		cached = { dateStamp, key };
		return key;
	};

	return async (input) => {
		const canonicalUri = objectUri(config, endpoint.basePath, input.key);
		const canonicalQuery = canonicalizeQuery(input.query ?? {});
		const payloadHash = await payloadDigest(input.body, endpoint.protocol);
		const amzDate = amzTimestamp();
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

		const scope = `${dateStamp}/${region}/${SIGV4_SERVICE}/aws4_request`;
		const stringToSign = [
			SIGV4_ALGORITHM,
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
					`${SIGV4_ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
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
 * R2 accepts the default region "auto", but AWS does not: without an endpoint, `s3.auto.amazonaws.com` resolves nowhere.
 * us-east-1 instead fails with a 400 naming the bucket's real region, which the user can act on.
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

/**
 * Hashing uploads costs a second full UI-thread pass per blob. HTTPS uses TLS integrity and AWS's documented
 * UNSIGNED-PAYLOAD; plain HTTP (a LAN MinIO) has no transport integrity, so the body is hashed.
 */
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
