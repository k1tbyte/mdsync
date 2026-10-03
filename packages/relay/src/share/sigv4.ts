/** Minimal SigV4 presigner on WebCrypto: the AWS SDK is too heavy for a Worker bundle. */

import { toHex } from "@mdsync/protocol";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

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
	const amzDate = new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}/, "");
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${target.region}/${SERVICE}/aws4_request`;
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
			"X-Amz-Algorithm": ALGORITHM,
			"X-Amz-Credential": `${target.accessKeyId}/${scope}`,
			"X-Amz-Date": amzDate,
			"X-Amz-Expires": String(expiresIn),
			"X-Amz-SignedHeaders": "host",
		};
		const canonicalQuery = Object.keys(params)
			.sort()
			.map(
				(name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name] ?? "")}`,
			)
			.join("&");

		const canonicalRequest = [
			method,
			canonicalUri,
			canonicalQuery,
			`host:${host}\n`,
			"host",
			UNSIGNED_PAYLOAD,
		].join("\n");

		const stringToSign = [
			ALGORITHM,
			amzDate,
			scope,
			toHex(await sha256(canonicalRequest)),
		].join("\n");

		derivedKey ??= signingKey(target, dateStamp);
		const signature = toHex(await hmac(await derivedKey, stringToSign));
		return `${endpoint.protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
	};
}

async function signingKey(
	target: S3Target,
	dateStamp: string,
): Promise<CryptoKey> {
	let key = await importHmacKey(
		encoder.encode(`AWS4${target.secretAccessKey}`),
	);
	for (const part of [dateStamp, target.region, SERVICE, "aws4_request"]) {
		key = await importHmacKey(await hmac(key, part));
	}
	return key;
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

function sha256(data: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", encoder.encode(data));
}

function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

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
