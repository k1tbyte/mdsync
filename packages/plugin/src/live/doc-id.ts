import { toHex } from "@mdsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";

/** 16 bytes of HMAC: collision-free at any vault size, short on the wire. */
const DOC_ID_BYTES = 16;
/** Ids asked for again and again (every push, every open) are kept; old ones drop past this. */
const MAX_REMEMBERED = 4096;
const encoder = new TextEncoder();
const remembered = new WeakMap<LiveKeys, Map<string, Promise<string>>>();

/**
 * The hub routes by this id, never the path. The generation is signed with the path: rotation derives a new
 * room's id, so two devices rotating at once land in the same room.
 */
export function docIdFor(
	keys: LiveKeys,
	path: string,
	generation: number,
): Promise<string> {
	const name = `${path}#${generation}`;
	const ids = remembered.get(keys) ?? new Map<string, Promise<string>>();
	remembered.set(keys, ids);
	const known = ids.get(name);
	if (known) return known;
	if (ids.size >= MAX_REMEMBERED) ids.delete(ids.keys().next().value as string);
	const id = sign(keys, name);
	ids.set(name, id);
	return id;
}

async function sign(keys: LiveKeys, name: string): Promise<string> {
	const mac = new Uint8Array(
		await crypto.subtle.sign("HMAC", keys.docIds, encoder.encode(name)),
	);
	return toHex(mac.subarray(0, DOC_ID_BYTES));
}
