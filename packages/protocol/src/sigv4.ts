/**
 * SigV4 pieces on WebCrypto that the plugin's request signer and the relay's presigner share. Each keeps its
 * own request flow and its own signing-key cache.
 */

export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
export const SIGV4_SERVICE = "s3";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const encoder = new TextEncoder();

function importHmacKey(raw: BufferSource): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		raw,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

export function hmac(key: CryptoKey, data: string): Promise<ArrayBuffer> {
	return crypto.subtle.sign("HMAC", key, encoder.encode(data));
}

/** Stable per (secret, day, region): deriving is the CPU cost, so callers cache the result. */
export async function deriveSigningKey(
	secretAccessKey: string,
	dateStamp: string,
	region: string,
): Promise<CryptoKey> {
	let key = await importHmacKey(encoder.encode(`AWS4${secretAccessKey}`));
	for (const part of [dateStamp, region, SIGV4_SERVICE, "aws4_request"]) {
		key = await importHmacKey(await hmac(key, part));
	}
	return key;
}

/** `encodeURIComponent` leaves these, and SigV4 requires them encoded. */
export function encodeRfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Percent-encodes each path segment, leaving the separators intact. */
export function encodePath(path: string): string {
	return path.split("/").map(encodeRfc3986).join("/");
}

/** An endpoint's path arrives encoded: decoding it first keeps `encodePath` from encoding it twice. */
export function decodePath(path: string): string {
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

export function canonicalizeQuery(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] ?? "")}`)
		.join("&");
}

/** `20260907T101530Z`, the only format SigV4 accepts. */
export function amzTimestamp(): string {
	return new Date()
		.toISOString()
		.replace(/[:-]/g, "")
		.replace(/\.\d{3}/, "");
}
