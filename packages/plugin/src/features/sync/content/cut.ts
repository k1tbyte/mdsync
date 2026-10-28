import { type ChunkParams, chunkEnds, gearTable } from "@/core/chunking";
import { chunkId } from "@/core/crypto";
import { encodeDrawing } from "@/core/drawing";

// Every device cuts with the same seed and sizes, or one file would be cut two ways and share nothing.
const GEAR = gearTable(0x6d64);
const KB = 1024;
const SMALL_CHUNKS: ChunkParams = { min: 16 * KB, avg: 64 * KB, max: 256 * KB };
/** Past it, bigger chunks keep a file's recipe and request count small. */
const LARGE_FILE = 16 * KB * KB;
const LARGE_CHUNKS: ChunkParams = {
	min: 256 * KB,
	avg: 1024 * KB,
	max: 4096 * KB,
};

/** The stored form of a file of `size` bytes, cut into chunks: views of `stored`, no copies. */
export function cut(stored: Uint8Array, size: number): Uint8Array[] {
	const params = size > LARGE_FILE ? LARGE_CHUNKS : SMALL_CHUNKS;
	let start = 0;
	return chunkEnds(stored, params, GEAR).map((end) => {
		const part = stored.subarray(start, end);
		start = end;
		return part;
	});
}

/**
 * The chunks of `local`, a file's copy on this disk, that are among `wanted`: cut as a file of `size` bytes,
 * the remote one's, since the size picks the chunk sizes. None when it does not read.
 */
export async function chunksOf(
	chunkIds: CryptoKey,
	local: () => Promise<Uint8Array | null>,
	size: number,
	wanted: ReadonlySet<string>,
): Promise<Map<string, Uint8Array>> {
	const bytes = await local().catch(() => null);
	const found = new Map<string, Uint8Array>();
	if (!bytes) return found;
	const parts = cut(encodeDrawing(bytes)?.stored ?? bytes, size);
	const ids = await Promise.all(parts.map((part) => chunkId(chunkIds, part)));
	parts.forEach((part, index) => {
		const id = ids[index] as string;
		if (wanted.has(id)) found.set(id, part);
	});
	return found;
}
