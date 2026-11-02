/** Minimal SigV4 presigner on WebCrypto: the AWS SDK is too heavy for a Worker bundle. */

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

export interface S3Target {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

export type PresignMethod = "GET" | "PUT" | "DELETE" | "HEAD";

const encoder = new TextEncoder();

export type Presigner = (
	method: PresignMethod,
	key: string,
	query?: Record<string, string>,
) => Promise<string>;

export async function presignS3(
	target: S3Target,
	method: PresignMethod,
	key: string,
	expiresIn: number,
	query: Record<string, string> = {},
): Promise<string> {
	return createPresigner(target, expiresIn)(method, key, query);
}

/** One date and one derived signing key serve every URL a batch signs; deriving is the main CPU cost. */
export function createPresigner(
	target: S3Target,
	expiresIn: number,
): Presigner {
	const endpoint = new URL(target.endpoint);
	const host = target.forcePathStyle
		? endpoint.host
		: `${target.bucket}.${endpoint.host}`;
	const basePath = decodePath(endpoint.pathname.replace(/\/+$/, ""));
	const amzDate = amzTimestamp();
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${target.region}/${SIGV4_SERVICE}/aws4_request`;
	let derivedKey: Promise<CryptoKey> | undefined;

	return async (method, key, query = {}) => {
		// A bucket-level call (list) has no key: its canonical URI is the bucket
		// itself, and a trailing slash would sign a path S3 does not resolve to it.
		const objectPath = target.forcePathStyle
			? key
				? `/${target.bucket}/${key}`
				: `/${target.bucket}`
			: `/${key}`;
		const canonicalUri = encodePath(`${basePath}${objectPath}`);

		const params: Record<string, string> = {
			...query,
			"X-Amz-Algorithm": SIGV4_ALGORITHM,
			"X-Amz-Credential": `${target.accessKeyId}/${scope}`,
			"X-Amz-Date": amzDate,
			"X-Amz-Expires": String(expiresIn),
			"X-Amz-SignedHeaders": "host",
		};
		const canonicalQuery = canonicalizeQuery(params);

		const canonicalRequest = [
			method,
			canonicalUri,
			canonicalQuery,
			`host:${host}\n`,
			"host",
			UNSIGNED_PAYLOAD,
		].join("\n");

		const stringToSign = [
			SIGV4_ALGORITHM,
			amzDate,
			scope,
			toHex(await sha256(canonicalRequest)),
		].join("\n");

		derivedKey ??= cachedSigningKey(target, dateStamp);
		const signature = toHex(await hmac(await derivedKey, stringToSign));
		return `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
	};
}

const KEY_CACHE_MAX = 16;
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The key only changes with the day, so the isolate derives it once per day and credential, not per request. */
function cachedSigningKey(
	target: S3Target,
	dateStamp: string,
): Promise<CryptoKey> {
	const id = JSON.stringify([
		target.accessKeyId,
		target.secretAccessKey,
		target.region,
		dateStamp,
	]);
	const known = keyCache.get(id);
	if (known) return known;
	if (keyCache.size >= KEY_CACHE_MAX) {
		keyCache.delete(keyCache.keys().next().value as string);
	}
	const derived = deriveSigningKey(
		target.secretAccessKey,
		dateStamp,
		target.region,
	);
	keyCache.set(id, derived);
	derived.catch(() => {
		if (keyCache.get(id) === derived) keyCache.delete(id);
	});
	return derived;
}

function sha256(data: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(data));
}
