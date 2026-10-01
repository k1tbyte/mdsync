import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { autoMergeOp, isTextMergeCandidate } from "@/sync/auto-merge";
import { pushPathsOp } from "@/sync/operations/push";
import { recomputeAfterWrite } from "@/sync/session-state";

useEncryptionKey();

const BASE = ["one", "two", "three", "four", "five", "six", ""].join("\n");

/** Two devices that both know `BASE`, then each edits it independently. */
async function diverged(
	localText: string,
	remoteText: string,
	base = BASE,
): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	a.adapter.putText("note.md", base);
	const first = await a.compare();
	await pushPathsOp(a.deps(), first, ["note.md"], a.context());

	b.adapter.putText("note.md", base);
	await b.adoptRemote();

	b.adapter.putText("note.md", remoteText);
	const bResult = await b.compare();
	await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

	a.adapter.putText("note.md", localText);
	return [a, b];
}

describe("autoMergeOp", () => {
	it("writes nothing once cancelled: a moved share's old path is the vault's", async () => {
		const localText = BASE.replace("one", "ONE");
		const [a] = await diverged(localText, BASE.replace("six", "SIX"));
		const result = await a.compare();
		const aborter = new AbortController();
		aborter.abort();

		const outcome = await autoMergeOp(
			{ ...a.deps(), signal: aborter.signal },
			result,
			a.context(),
		);

		expect(outcome.cancelled).toBe(true);
		expect(outcome.touchedPaths.size).toBe(0);
		expect(a.text("note.md")).toBe(localText);
	});

	it("merges edits that do not overlap and keeps the result pushable", async () => {
		const [a] = await diverged(
			BASE.replace("one", "ONE"),
			BASE.replace("six", "SIX"),
		);
		const result = await a.compare();
		expect(result.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		const merged = a.text("note.md");
		expect(merged).toContain("ONE");
		expect(merged).toContain("SIX");
		expect(outcome.touchedPaths).toEqual(new Set(["note.md"]));

		const recomputed = recomputeAfterWrite(
			result,
			a.state,
			outcome,
			a.deps().scope,
		);
		expect(recomputed.diff.conflicts).toHaveLength(0);
		expect(recomputed.diff.localChanges.map((c) => c.path)).toEqual([
			"note.md",
		]);

		await pushPathsOp(a.deps(), recomputed, ["note.md"], a.context());
		const after = await a.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(a.text("note.md")).toBe(merged);
	});

	it("records the mtime it wrote so the next scan does not re-hash", async () => {
		const [a] = await diverged(
			BASE.replace("one", "ONE"),
			BASE.replace("six", "SIX"),
		);
		const result = await a.compare();
		const outcome = await autoMergeOp(a.deps(), result, a.context());

		const stat = await a.adapter.stat("note.md");
		const entry = outcome.localEntries?.get("note.md");
		expect(entry?.mtime).toBe(stat?.mtime);
		expect(a.state.hashCache["note.md"]?.hash).toBe(entry?.hash);
	});

	it("never merges a drawing it cannot read by lines", async () => {
		const drawing = `---\nexcalidraw-plugin: parsed\n---\n${BASE}`;
		const [a] = await diverged(
			drawing.replace("one", "ONE"),
			drawing.replace("six", "SIX"),
			drawing,
		);
		const result = await a.compare();

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths.size).toBe(0);
	});

	it("leaves a file that is not UTF-8 byte for byte", async () => {
		const [a] = await diverged(BASE, BASE.replace("six", "SIX"));
		const latin1 = new Uint8Array([
			...new TextEncoder().encode("ONE caf"),
			0xe9,
			...new TextEncoder().encode("\ntwo\nthree\nfour\nfive\nsix\n"),
		]);
		await a.adapter.writeBinary("note.md", latin1.slice().buffer);
		const result = await a.compare();

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths.size).toBe(0);
		expect(new Uint8Array(await a.adapter.readBinary("note.md"))).toEqual(
			latin1,
		);
	});

	it("leaves an overlapping conflict for the user", async () => {
		const [a] = await diverged(
			BASE.replace("three", "LOCAL"),
			BASE.replace("three", "REMOTE"),
		);
		const result = await a.compare();

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths.size).toBe(0);
		expect(outcome.localEntries).toBeUndefined();
		expect(a.text("note.md")).toContain("LOCAL");
	});

	it("skips a conflict with no common ancestor", async () => {
		const [a, b] = pairedSessions();
		b.adapter.putText("new.md", "from b\n");
		const bFirst = await b.compare();
		await pushPathsOp(b.deps(), bFirst, ["new.md"], b.context());

		a.adapter.putText("new.md", "from a\n");
		const result = await a.compare();
		expect(result.diff.conflicts[0]?.baselineHash).toBeNull();

		const outcome = await autoMergeOp(a.deps(), result, a.context());
		expect(outcome.touchedPaths.size).toBe(0);
		expect(a.text("new.md")).toBe("from a\n");
	});
});

describe("isTextMergeCandidate", () => {
	const [a] = pairedSessions();
	const deps = { adapter: a.adapter.asDataAdapter() };

	function withSize(path: string, size: number) {
		return {
			version: 1,
			vaultId: "v",
			snapshotId: "s",
			parentSnapshotId: null,
			createdAt: 0,
			deviceId: "d",
			files: {
				[path]: { hash: "h", size, mtime: 0, kind: "vault" as never },
			},
		};
	}

	it("rejects a known binary extension without reading anything", async () => {
		expect(await isTextMergeCandidate(deps, "image.png", null, null)).toBe(
			false,
		);
	});

	it("rejects a side that is too large to diff", async () => {
		const huge = withSize("big.md", 50_000_000);
		expect(await isTextMergeCandidate(deps, "big.md", huge, null)).toBe(false);
		expect(await isTextMergeCandidate(deps, "big.md", null, huge)).toBe(false);
	});

	it("accepts an ordinary note", async () => {
		expect(await isTextMergeCandidate(deps, "note.md", null, null)).toBe(true);
	});
});
