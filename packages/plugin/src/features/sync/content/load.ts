import {
	decryptBytes,
	decryptDescribed,
	type EncryptionKey,
	isDescribed,
	sha256Hex,
} from "@/core/crypto";
import { decodeDrawing } from "@/core/drawing";
import type { ObjectStorage } from "@/features/storage";
import { objectKey } from "../remote/manifest";
import { readHeader } from "./header";

export interface ContentSource {
	storage: ObjectStorage;
	key: EncryptionKey;
}

/**
 * The file `hash` names, or null only when its object is absent; any other failure throws. `size`: the file's
 * expected bytes, which the storage turns into a longer transfer deadline.
 */
export async function loadContent(
	source: ContentSource,
	hash: string,
	size?: number,
): Promise<Uint8Array | null> {
	const blob = await source.storage.get(objectKey(hash), size);
	if (!blob) return null;
	return openContent(source.key, blob, hash);
}

/**
 * The bytes a blob holds for `hash`, checked against it: a rebuilt file that does not hash to its name is
 * refused. For a caller that fetches the blob itself and must tell a failed read from a bad blob.
 */
export async function openContent(
	key: EncryptionKey,
	blob: Uint8Array,
	hash: string,
): Promise<Uint8Array> {
	const bytes = await unseal(key, blob);
	if ((await sha256Hex(bytes)) !== hash) {
		throw new Error(`Hash mismatch for remote object ${hash}`);
	}
	return bytes;
}

async function unseal(
	key: EncryptionKey,
	blob: Uint8Array,
): Promise<Uint8Array> {
	if (!isDescribed(blob)) return decryptBytes(key, blob);
	const { header, payload } = await decryptDescribed(key, blob);
	const { codec } = readHeader(header);
	return codec ? decodeDrawing(payload, codec) : payload;
}
