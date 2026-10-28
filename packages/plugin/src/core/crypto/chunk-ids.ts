import { toHex } from "@mdsync/protocol";
import { deriveFromDataKey } from "./hkdf";

const CHUNK_IDS_INFO = "mdsync/chunks/ids/v1";

/** HMAC-SHA-256 naming chunks, so the storage never learns their plain hashes. */
export function deriveChunkIds(dataKey: Uint8Array): Promise<CryptoKey> {
	return deriveFromDataKey(
		dataKey,
		CHUNK_IDS_INFO,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		["sign"],
	);
}

/** Equal bytes get one name under one data key, so versions of a file share their unchanged chunks. */
export async function chunkId(
	key: CryptoKey,
	bytes: Uint8Array,
): Promise<string> {
	const mac = await window.crypto.subtle.sign(
		"HMAC",
		key,
		bytes as BufferSource,
	);
	return toHex(mac);
}
