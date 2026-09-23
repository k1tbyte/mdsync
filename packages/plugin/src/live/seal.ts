/**
 * Everything the live layer sends is sealed here. The hub routes by docId and
 * stores ciphertext, so neither the path nor the keystrokes leave the device.
 */

import type { LiveKeys } from "@/crypto/live-keys";

const IV_BYTES = 12;
/** 16 bytes of HMAC: collision-free at any vault size, short on the wire. */
const DOC_ID_BYTES = 16;

export async function seal(
	keys: LiveKeys,
	data: Uint8Array,
): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			keys.frames,
			data as BufferSource,
		),
	);
	const frame = new Uint8Array(IV_BYTES + sealed.length);
	frame.set(iv);
	frame.set(sealed, IV_BYTES);
	return frame;
}

/** Null for anything this key cannot open: a stale key must not throw per keystroke. */
export async function unseal(
	keys: LiveKeys,
	frame: Uint8Array,
): Promise<Uint8Array | null> {
	if (frame.length <= IV_BYTES) return null;
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: frame.subarray(0, IV_BYTES) as BufferSource },
				keys.frames,
				frame.subarray(IV_BYTES) as BufferSource,
			),
		);
	} catch {
		return null;
	}
}

/**
 * The generation is signed with the path: rotation gives a document a new room
 * by deriving its id, so two devices rotating at once land in the same room.
 */
export async function docIdFor(
	keys: LiveKeys,
	path: string,
	generation: number,
): Promise<string> {
	const mac = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			keys.docIds,
			new TextEncoder().encode(`${path}#${generation}`),
		),
	);
	let hex = "";
	for (const byte of mac.subarray(0, DOC_ID_BYTES)) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}
