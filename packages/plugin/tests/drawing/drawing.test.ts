import { compressToBase64 } from "lz-string";
import { describe, expect, it } from "vitest";

import {
	mergeDrawings,
	mergeElements,
	readDrawing,
	type SceneElement,
	sceneOf,
} from "@/drawing";

function element(
	id: string,
	version = 1,
	extra: Partial<SceneElement> = {},
): SceneElement {
	return { id, version, versionNonce: version, index: `a${id}`, ...extra };
}

function drawing(
	elements: SceneElement[],
	{
		appState = { zoom: { value: 1 } },
		notes = "",
		embedded = "",
		compressed = false,
	} = {},
): string {
	const json = JSON.stringify({ type: "excalidraw", elements, appState });
	const block = compressed
		? `\`\`\`compressed-json\n${compressToBase64(json).replace(/(.{64})/g, "$1\n\n")}\n\`\`\``
		: `\`\`\`json\n${json}\n\`\`\``;
	const files = embedded ? `## Embedded Files\n${embedded}\n\n` : "";
	return `---\n\nexcalidraw-plugin: parsed\n\n---\n${notes}# Excalidraw Data\n\n## Text Elements\n${files}%%\n## Drawing\n${block}\n%%\n`;
}

function ids(text: string | null): string[] {
	return (
		readDrawing(text ?? "")?.scene.elements.map(
			({ id, version }) => `${id}@${version}`,
		) ?? []
	);
}

describe("drawings", () => {
	it("reads plain and compressed scenes, and nothing else", () => {
		const elements = [element("1"), element("2")];
		expect(ids(drawing(elements))).toEqual(["1@1", "2@1"]);
		expect(ids(drawing(elements, { compressed: true }))).toEqual([
			"1@1",
			"2@1",
		]);
		expect(readDrawing("# a note\n## Drawing\n```json\n{}\n```")).toBeNull();
	});

	it("fingerprints the scene, not the view state it was saved with", async () => {
		const scene = [element("1"), element("2", 1, { isDeleted: true })];
		const here = await sceneOf(drawing(scene));
		expect(
			await sceneOf(
				drawing([element("1")], { appState: { zoom: { value: 3 } } }),
			),
		).toBe(here);
		expect(await sceneOf(drawing([element("1", 2)]))).not.toBe(here);
		expect(await sceneOf(drawing(scene, { notes: "todo\n" }))).not.toBe(here);
		expect(await sceneOf("# a note")).toBeUndefined();
	});

	it("merges by element: winners, drops and additions", () => {
		const base = [
			element("1"),
			element("2"),
			element("3"),
			element("4"),
			element("7"),
			element("8"),
		];
		const local = [
			element("1", 2),
			element("2", 3),
			element("4", 2),
			element("5"),
		];
		const remote = [
			element("1"),
			element("2", 2),
			element("4"),
			element("6"),
			element("7"),
			element("8", 2),
		];

		expect(
			mergeElements(base, local, remote).map(({ id, version }) => [
				id,
				version,
			]),
		).toEqual([
			["1", 2],
			["2", 3],
			["4", 2],
			["5", 1],
			["6", 1],
			["8", 2],
		]);
	});

	it("keeps the lower nonce when both sides reach one version", () => {
		const merged = mergeElements(
			[element("1")],
			[element("1", 2, { versionNonce: 9 })],
			[element("1", 2, { versionNonce: 4 })],
		);
		expect(merged[0]?.versionNonce).toBe(4);
	});

	it("merges two files and keeps the images either side added", () => {
		const base = drawing([element("1")]);
		const local = drawing([element("1", 2), element("2")], {
			embedded: "f1: [[one.png]]",
		});
		const remote = drawing([element("1"), element("3")], {
			appState: { zoom: { value: 2 } },
			embedded: "f2: [[two.png]]",
		});

		const merged = mergeDrawings(base, local, remote);

		expect(ids(merged)).toEqual(["1@2", "2@1", "3@1"]);
		expect(merged).toContain("f1: [[one.png]]");
		expect(merged).toContain("f2: [[two.png]]");
		expect(readDrawing(merged ?? "")?.scene.appState).toEqual({
			zoom: { value: 1 },
		});
	});

	it("leaves notes both sides edited to the person", () => {
		const base = drawing([element("1")]);
		expect(
			mergeDrawings(
				base,
				drawing([element("1")], { notes: "mine\n" }),
				drawing([element("1")], { notes: "theirs\n" }),
			),
		).toBeNull();
		const theirNotes = mergeDrawings(
			base,
			drawing([element("1", 2)]),
			drawing([element("1")], { notes: "theirs\n" }),
		);
		expect(theirNotes).toContain("theirs");
		expect(ids(theirNotes)).toEqual(["1@2"]);
	});
});
