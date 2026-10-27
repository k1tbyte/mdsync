/**
 * Seals everything the relay carries (frames, cursors, presence): the hub sees only ciphertext, so no paths
 * or keystrokes leave the device.
 */

import { IV_BYTES } from "./constants";
import type { LiveKeys } from "./live-keys";

const encoder = new TextEncoder();

/**
 * Sealed in as additional data: the relay cannot move a frame to another document, or a cursor or rename note
 * into one.
 */
export type SealedFor =
	| `doc:${string}`
	| `awareness:${string}`
	| `moved:${string}`
	| "presence";

export async function seal(
	keys: LiveKeys,
	data: Uint8Array,
	sealedFor: SealedFor,
): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: encoder.encode(sealedFor) },
			keys.frames,
			data as BufferSource,
		),
	);
	const frame = new Uint8Array(IV_BYTES + sealed.length);
	frame.set(iv);
	frame.set(sealed, IV_BYTES);
	return frame;
}

/** Null for anything this key cannot open, or sealed for elsewhere: a stale key must not throw per keystroke. */
export async function unseal(
	keys: LiveKeys,
	frame: Uint8Array,
	sealedFor: SealedFor,
): Promise<Uint8Array | null> {
	if (frame.length <= IV_BYTES) return null;
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: frame.subarray(0, IV_BYTES) as BufferSource,
					additionalData: encoder.encode(sealedFor),
				},
				keys.frames,
				frame.subarray(IV_BYTES) as BufferSource,
			),
		);
	} catch {
		return null;
	}
}
