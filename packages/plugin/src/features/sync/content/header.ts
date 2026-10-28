import { type DrawingCodec, isDrawingCodec } from "@/core/drawing";

/** A chunk's id and its plain size. */
export type ChunkRef = [id: string, size: number];

/** What a described root (`BLOB_VERSION_DESCRIBED`) says about how its payload maps to the file. */
export interface ContentHeader {
	/** Absent: the stored form is the file. */
	codec?: DrawingCodec;
	/** The stored form, in order; only a `recipes/` root names them, with an empty payload. */
	chunks?: ChunkRef[];
}

/** Anything this build does not know makes the content unreadable: guessing could only give wrong bytes. */
export function readHeader(header: unknown, recipe: boolean): ContentHeader {
	if (typeof header !== "object" || header === null || Array.isArray(header)) {
		throw new Error("Unreadable content header");
	}
	const { codec, chunks, ...rest } = header as Record<string, unknown>;
	if (Object.keys(rest).length > 0) throw new Error("Unknown content header");
	if (codec !== undefined && !isDrawingCodec(codec)) {
		throw new Error("Unknown content codec");
	}
	if (chunks === undefined) {
		if (recipe) throw new Error("A recipe names no chunks");
		return codec ? { codec } : {};
	}
	if (!recipe || !Array.isArray(chunks) || !chunks.every(isChunkRef)) {
		throw new Error("Unreadable chunk list");
	}
	return codec ? { codec, chunks } : { chunks };
}

function isChunkRef(value: unknown): value is ChunkRef {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [id, size] = value;
	return (
		typeof id === "string" &&
		id.length > 0 &&
		!id.includes("/") &&
		Number.isInteger(size) &&
		size >= 0
	);
}
