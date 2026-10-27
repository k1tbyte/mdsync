const FORMAT: CompressionFormat = "deflate-raw";

/** Widest support: shipped with CompressionStream itself, while "deflate-raw" came three Chromium releases later. */
export const GZIP: CompressionFormat = "gzip";

/** Returns null when the platform lacks CompressionStream. */
export async function deflateBytes(
	bytes: Uint8Array,
	format: CompressionFormat = FORMAT,
): Promise<Uint8Array | null> {
	if (typeof CompressionStream !== "function") return null;
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateBytes(
	bytes: Uint8Array,
	format: CompressionFormat = FORMAT,
): Promise<Uint8Array> {
	if (typeof DecompressionStream !== "function") {
		throw new Error("This device cannot decompress MDSync links");
	}
	const stream = new Blob([bytes as unknown as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
