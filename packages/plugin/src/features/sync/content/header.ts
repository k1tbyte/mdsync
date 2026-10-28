import { type DrawingCodec, isDrawingCodec } from "@/core/drawing";

/** What a described root (`BLOB_VERSION_DESCRIBED`) says about how its payload maps to the file. */
export interface ContentHeader {
	/** Absent: the payload is the file. */
	codec?: DrawingCodec;
}

/** Anything this build does not know makes the content unreadable: guessing could only give wrong bytes. */
export function readHeader(header: unknown): ContentHeader {
	if (typeof header !== "object" || header === null || Array.isArray(header)) {
		throw new Error("Unreadable content header");
	}
	const { codec, ...rest } = header as Record<string, unknown>;
	if ("chunks" in rest) {
		throw new Error(
			"This content is stored in chunks, which this version cannot read. Update the plugin.",
		);
	}
	if (Object.keys(rest).length > 0) {
		throw new Error("Unknown content header");
	}
	if (codec === undefined) return {};
	if (!isDrawingCodec(codec)) throw new Error("Unknown content codec");
	return { codec };
}
