/**
 * Keys of the live layer, one per purpose, derived from the vault's data key.
 * The content key is imported non-extractable, so these are derived where the
 * raw key is unwrapped rather than from the finished CryptoKey.
 */

export interface LiveKeys {
	/** AES-GCM-256 over every live frame the hub stores or forwards. */
	frames: CryptoKey;
	/** HMAC-SHA-256 naming documents, so the hub never learns a path. */
	docIds: CryptoKey;
}

const FRAMES_INFO = "obsync/live/frames/v1";
const DOC_IDS_INFO = "obsync/live/doc-ids/v1";

export async function deriveLiveKeys(dataKey: Uint8Array): Promise<LiveKeys> {
	const subtle = window.crypto.subtle;
	const material = await subtle.importKey(
		"raw",
		dataKey as BufferSource,
		"HKDF",
		false,
		["deriveKey"],
	);
	const purpose = (info: string): HkdfParams => ({
		name: "HKDF",
		hash: "SHA-256",
		// The data key is uniformly random, so HKDF needs no salt to extract.
		salt: new Uint8Array(),
		info: new TextEncoder().encode(info),
	});
	return {
		frames: await subtle.deriveKey(
			purpose(FRAMES_INFO),
			material,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		),
		docIds: await subtle.deriveKey(
			purpose(DOC_IDS_INFO),
			material,
			{ name: "HMAC", hash: "SHA-256", length: 256 },
			false,
			["sign"],
		),
	};
}
