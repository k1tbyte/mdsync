import { encryptCompressible, encryptDescribed } from "@/core/crypto";
import { encodeDrawing } from "@/core/drawing";
import { objectKey } from "./keys";
import type { ContentSource } from "./load";

/** PUTs `bytes` as the object named `hash`. Whether the storage already holds it is the caller's call. */
export async function storeContent(
	source: ContentSource,
	hash: string,
	bytes: Uint8Array,
): Promise<void> {
	await source.storage.put(objectKey(hash), await seal(source.key, bytes));
}

async function seal(
	key: ContentSource["key"],
	bytes: Uint8Array,
): Promise<Uint8Array> {
	const drawing = encodeDrawing(bytes);
	if (drawing) {
		try {
			return await encryptDescribed(
				key,
				{ codec: drawing.codec },
				drawing.stored,
			);
		} catch {
			// No CompressionStream here: a plain blob is one every peer reads.
		}
	}
	return encryptCompressible(key, bytes);
}
