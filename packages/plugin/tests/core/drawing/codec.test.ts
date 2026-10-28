import {
	bytesOf,
	compressedDrawing,
	drawingAround,
	exactMultipleScene,
	plainDrawing,
	sceneJson,
	wrapLikeExcalidraw,
} from "@tests/helpers/drawing-file";
import { compressToBase64 } from "lz-string";
import { describe, expect, it } from "vitest";
import {
	type DrawingCodec,
	decodeDrawing,
	encodeDrawing,
	isDrawingCodec,
} from "@/core/drawing/codec";

const decoder = new TextDecoder();

function roundTrip(text: string) {
	const bytes = bytesOf(text);
	const encoded = encodeDrawing(bytes);
	expect(encoded).not.toBeNull();
	const { stored, codec } = encoded as NonNullable<typeof encoded>;
	expect(decodeDrawing(stored, codec)).toEqual(bytes);
	return { stored: decoder.decode(stored), codec };
}

describe("excalidraw codec", () => {
	it("stores a scene past its budget as it is, so no read rebuilds megabytes", () => {
		const json = JSON.stringify({
			type: "excalidraw",
			elements: [{ id: "a", text: "x".repeat(8 * 1024 * 1024) }],
		});
		expect(encodeDrawing(bytesOf(compressedDrawing(json)))).toBeNull();
		// Compressing 8 MB takes seconds, past the default timeout in a loaded suite.
	}, 30_000);

	it("stores the scene as plain JSON and rebuilds the file byte for byte", () => {
		const json = sceneJson(60);
		const { stored, codec } = roundTrip(compressedDrawing(json));

		expect(codec).toEqual({ name: "excalidraw-lz", width: 256, gap: "\n\n" });
		expect(stored).toContain(`\`\`\`json\n${json}\n\`\`\``);
		expect(stored).not.toContain("compressed-json");
		expect(stored).toContain("excalidraw-plugin: parsed");
	});

	it("round-trips when the base64 length is an exact multiple of the width", () => {
		const json = exactMultipleScene();
		const base64 = compressToBase64(json);
		expect(base64.length % 256).toBe(0);
		// The plugin's regex also puts the gap after a last full line.
		expect(wrapLikeExcalidraw(base64).endsWith("\n\n")).toBe(true);

		const { codec } = roundTrip(compressedDrawing(json));
		expect(codec).toMatchObject({ width: 256, gap: "\n\n" });
	});

	it("reads another writer's width and gap from the file", () => {
		const json = sceneJson(30);
		const wrapped = compressToBase64(json).replace(/(.{64})/g, "$1\n");
		const { codec } = roundTrip(
			drawingAround(`\`\`\`compressed-json\n${wrapped}\n\`\`\``),
		);
		expect(codec).toMatchObject({ width: 64, gap: "\n" });
	});

	it("handles one unwrapped line", () => {
		const json = sceneJson(2);
		roundTrip(
			drawingAround(`\`\`\`compressed-json\n${compressToBase64(json)}\n\`\`\``),
		);
	});

	it("keeps text after the block, with other blocks before and after it", () => {
		const text = `${compressedDrawing()}\n## Later\n\`\`\`json\n{"a":1}\n\`\`\`\n`;
		const { stored } = roundTrip(text);
		expect(stored.endsWith('{"a":1}\n```\n')).toBe(true);
	});

	it("gives null for a scene that is plain JSON already", () => {
		expect(encodeDrawing(bytesOf(plainDrawing()))).toBeNull();
	});

	it("gives null for anything that is not a drawing", () => {
		expect(encodeDrawing(bytesOf("# a note\n"))).toBeNull();
		expect(encodeDrawing(new Uint8Array())).toBeNull();
		expect(encodeDrawing(new Uint8Array([0, 255, 254, 1, 2]))).toBeNull();
		const block = `## Drawing\n\`\`\`compressed-json\n${compressToBase64("{}")}\n\`\`\``;
		expect(encodeDrawing(bytesOf(block))).toBeNull();
		const moved = `# A note\n\n---\nexcalidraw-plugin: parsed\n---\n${block}`;
		expect(encodeDrawing(bytesOf(moved))).toBeNull();
	});

	it("gives null when the block does not decompress", () => {
		const text = drawingAround("```compressed-json\n!!not base64!!\n```");
		expect(encodeDrawing(bytesOf(text))).toBeNull();
	});

	it("gives null for a tampered block that does not reproduce", () => {
		const json = sceneJson(30);
		const wrapped = wrapLikeExcalidraw(compressToBase64(json));
		// Uneven gaps decompress fine, but no single width and gap rebuild them.
		const uneven = wrapped.replace("\n\n", "\n\n\n");
		expect(
			encodeDrawing(
				bytesOf(drawingAround(`\`\`\`compressed-json\n${uneven}\n\`\`\``)),
			),
		).toBeNull();

		// A last line followed by trailing spaces is not what the codec writes back.
		const spaced = `${wrapped}  `;
		expect(
			encodeDrawing(
				bytesOf(drawingAround(`\`\`\`compressed-json\n${spaced}\n\`\`\``)),
			),
		).toBeNull();
	});

	it("gives null for a stream that is not the canonical LZString of its own JSON", () => {
		const valid = compressToBase64(sceneJson(10));
		const swapped = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
		const text = drawingAround(
			`\`\`\`compressed-json\n${wrapLikeExcalidraw(swapped)}\n\`\`\``,
		);
		expect(encodeDrawing(bytesOf(text))).toBeNull();
	});

	it("round-trips CRLF line endings, keeping them in the gap", () => {
		const text = compressedDrawing().replace(/\n/g, "\r\n");
		const { codec, stored } = roundTrip(text);
		expect(codec).toMatchObject({ width: 256, gap: "\r\n\r\n" });
		expect(stored).toContain("```json\r\n");
	});

	it("round-trips non-ASCII text around the scene", () => {
		const text = compressedDrawing().replace("label 0", "étiquette 🎨 日本語");
		roundTrip(text);
	});

	it("never reproduces a different file: only equal bytes are encoded", () => {
		for (const mutate of [
			(text: string) => text.replace("\n\n%%", "\n%%"),
			(text: string) => `${text}\u0000`,
			(text: string) =>
				text.replace("```compressed-json\n", "```compressed-json\n\n"),
		]) {
			const bytes = bytesOf(mutate(compressedDrawing()));
			const encoded = encodeDrawing(bytes);
			if (encoded) {
				expect(decodeDrawing(encoded.stored, encoded.codec)).toEqual(bytes);
			}
		}
	});

	it("refuses an unknown or malformed codec on decode", () => {
		const { stored } = roundTrip(compressedDrawing());
		const bytes = bytesOf(stored);
		const bad = [
			{ name: "other", width: 256, gap: "\n\n" },
			{ name: "excalidraw-lz", width: 0, gap: "\n\n" },
			{ name: "excalidraw-lz", width: 2.5, gap: "\n\n" },
			{ name: "excalidraw-lz", width: 256, gap: "x" },
			{ name: "excalidraw-lz", width: 256, gap: "\n\n", extra: 1 },
		];
		for (const codec of bad) {
			expect(isDrawingCodec(codec)).toBe(false);
			expect(() => decodeDrawing(bytes, codec as DrawingCodec)).toThrow();
		}
		expect(() =>
			decodeDrawing(bytesOf("# no scene"), {
				name: "excalidraw-lz",
				width: 256,
				gap: "\n\n",
			}),
		).toThrow(/no scene/);
	});
});
