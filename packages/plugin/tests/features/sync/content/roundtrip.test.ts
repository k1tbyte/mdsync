import {
	bytesOf,
	compressedDrawing,
	sceneJson,
} from "@tests/helpers/drawing-file";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { decryptDescribed } from "@/core/crypto";
import { pullPaths } from "@/features/sync/apply/pull";
import { objectKey } from "@/features/sync/content/keys";
import { pushPaths, pushSingleFile } from "@/features/sync/engine";

useEncryptionKey();

const decoder = new TextDecoder();

describe("a drawing across two devices", () => {
	it("is pushed described and pulled back byte for byte", async () => {
		const [a, b] = pairedSessions();
		const text = compressedDrawing(sceneJson(80));
		a.adapter.putText("map.excalidraw.md", text);
		a.adapter.putText("note.md", "a note\n");

		const first = await a.compare();
		const manifest = await pushPaths(a.deps(), first, [
			"map.excalidraw.md",
			"note.md",
		]);
		const drawing = manifest.files["map.excalidraw.md"];
		const note = manifest.files["note.md"];
		expect(drawing?.size).toBe(bytesOf(text).length);

		const blob = a.storage.map.get(objectKey(drawing?.hash ?? ""));
		expect(blob?.[0]).toBe(0x03);
		expect(a.storage.map.get(objectKey(note?.hash ?? ""))?.[0]).toBe(0x01);

		const pulled = await b.compare();
		await pullPaths(b.deps(), pulled, ["map.excalidraw.md", "note.md"]);
		expect(b.text("map.excalidraw.md")).toBe(text);
		expect(b.text("note.md")).toBe("a note\n");
	});

	it("is stored described by a single-file push too", async () => {
		const [a, b] = pairedSessions();
		const text = compressedDrawing(sceneJson(50));
		const first = await a.compare();
		const manifest = await pushSingleFile(
			a.deps(),
			first,
			"one.excalidraw.md",
			bytesOf(text),
		);
		const hash = manifest.files["one.excalidraw.md"]?.hash ?? "";
		const blob = a.storage.map.get(objectKey(hash));
		expect(blob?.[0]).toBe(0x03);
		const opened = await decryptDescribed(
			a.deps().key,
			blob ?? new Uint8Array(),
		);
		expect(decoder.decode(opened.payload)).toContain("```json\n");

		const pulled = await b.compare();
		await pullPaths(b.deps(), pulled, ["one.excalidraw.md"]);
		expect(b.text("one.excalidraw.md")).toBe(text);
	});

	it("stores an edited drawing as a new object that still reads back", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("map.excalidraw.md", compressedDrawing(sceneJson(40)));
		const first = await a.compare();
		const one = await pushPaths(a.deps(), first, ["map.excalidraw.md"]);
		a.state = { ...a.state, vaultId: one.vaultId, baseline: one };

		const edited = compressedDrawing(sceneJson(41));
		a.adapter.putText("map.excalidraw.md", edited);
		const second = await a.compare();
		const two = await pushPaths(a.deps(), second, ["map.excalidraw.md"]);
		expect(two.files["map.excalidraw.md"]?.hash).not.toBe(
			one.files["map.excalidraw.md"]?.hash,
		);

		const pulled = await b.compare();
		await pullPaths(b.deps(), pulled, ["map.excalidraw.md"]);
		expect(b.text("map.excalidraw.md")).toBe(edited);
	});
});
