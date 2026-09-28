import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";

import { readDrawing } from "@/drawing";
import { autoMergeOp } from "@/sync/auto-merge";
import { pushPathsOp } from "@/sync/operations/push";

useEncryptionKey();

/** A drawing whose elements stand at `versions`, saved at `zoom`. */
function drawing(versions: Record<string, number>, zoom = 1): string {
	const elements = Object.entries(versions).map(([id, version]) => ({
		id,
		version,
		versionNonce: version,
		index: `a${id}`,
	}));
	const scene = JSON.stringify({
		elements,
		appState: { zoom: { value: zoom } },
	});
	return `---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n%%\n## Drawing\n\`\`\`json\n${scene}\n\`\`\`\n%%\n`;
}

describe("drawings in the file sync", () => {
	it("takes one scene saved with another view for no change", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("d.md", drawing({ r: 1 }));
		await pushPathsOp(a.deps(), await a.compare(), ["d.md"], a.context());
		b.adapter.putText("d.md", drawing({ r: 1 }, 3));

		const onB = await b.compare();

		expect(onB.diff.converged).toEqual(["d.md"]);
		expect(onB.diff.localChanges).toEqual([]);
	});

	it("merges two devices' edits by element", async () => {
		const [a, b] = pairedSessions();
		const base = drawing({ r: 1, s: 1 });
		a.adapter.putText("d.md", base);
		await pushPathsOp(a.deps(), await a.compare(), ["d.md"], a.context());
		b.adapter.putText("d.md", base);
		await b.adoptRemote();
		b.adapter.putText("d.md", drawing({ r: 1, s: 2 }, 2));
		await pushPathsOp(b.deps(), await b.compare(), ["d.md"], b.context());
		a.adapter.putText("d.md", drawing({ r: 2, s: 1 }));

		const result = await a.compare();
		expect(result.diff.conflicts.map(({ path }) => path)).toEqual(["d.md"]);
		await autoMergeOp(a.deps(), result, a.context());

		expect(
			readDrawing(a.text("d.md"))?.scene.elements.map(
				({ id, version }) => `${id}@${version}`,
			),
		).toEqual(["r@2", "s@2"]);
	});
});
