import { Device, disabled } from "@tests/helpers/config-device";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import {
	autoMergeOp,
	isTextMergeCandidate,
} from "@/features/sync/apply/auto-merge";
import type { LiveNotes } from "@/features/sync/live-notes";
import { pushPathsOp } from "@/features/sync/operations/push";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import { recomputeAfterWrite } from "@/features/sync/session-state";

useEncryptionKey();

const BASE = ["one", "two", "three", "four", "five", "six", ""].join("\n");

/** Two devices that both know `BASE`, then each edits it independently. */
async function diverged(
	localText: string,
	remoteText: string,
	base = BASE,
	path = "note.md",
): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	a.adapter.putText(path, base);
	const first = await a.compare();
	await pushPathsOp(a.deps(), first, [path], a.context());

	b.adapter.putText(path, base);
	await b.adoptRemote();

	b.adapter.putText(path, remoteText);
	const bResult = await b.compare();
	await pushPathsOp(b.deps(), bResult, [path], b.context());

	a.adapter.putText(path, localText);
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

	it.each(["data.json", "board.canvas", "script.js"])(
		"leaves a %s conflict for the merge screen even when lines do not overlap",
		async (path) => {
			const localText = BASE.replace("one", "ONE");
			const [a] = await diverged(
				localText,
				BASE.replace("six", "SIX"),
				BASE,
				path,
			);
			const result = await a.compare();
			expect(result.diff.conflicts.map((c) => c.path)).toEqual([path]);

			const outcome = await autoMergeOp(a.deps(), result, a.context());

			expect(outcome.touchedPaths.size).toBe(0);
			expect(a.text(path)).toBe(localText);
		},
	);

	it("merges a note whatever the case of its extension", async () => {
		const [a] = await diverged(
			BASE.replace("one", "ONE"),
			BASE.replace("six", "SIX"),
			BASE,
			"NOTE.MD",
		);
		const result = await a.compare();

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths).toEqual(new Set(["NOTE.MD"]));
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

	it("leaves a note typed into while the remote sides download", async () => {
		const [a] = await diverged(
			BASE.replace("one", "ONE"),
			BASE.replace("six", "SIX"),
		);
		const result = await a.compare();
		const typed = BASE.replace("one", "ONE, and more");
		let localRead = (): void => undefined;
		const read = new Promise<void>((resolve) => {
			localRead = resolve;
		});
		const readBinary = a.adapter.readBinary.bind(a.adapter);
		vi.spyOn(a.adapter, "readBinary").mockImplementation(async (path) => {
			const bytes = await readBinary(path);
			localRead();
			return bytes;
		});
		const get = a.storage.get.bind(a.storage);
		vi.spyOn(a.storage, "get").mockImplementation(async (key) => {
			await read;
			a.adapter.putText("note.md", typed);
			return get(key);
		});

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(a.text("note.md")).toBe(typed);
		expect(outcome.touchedPaths.size).toBe(0);
	});

	it("lets no room open on a merge before its merge base is saved", async () => {
		const [a] = await diverged(
			BASE.replace("one", "ONE"),
			BASE.replace("six", "SIX"),
		);
		const result = await a.compare();
		const remote = result.remote?.files["note.md"];
		if (!result.remote || !remote) throw new Error("expected the remote note");
		result.remote.files["note.md"] = {
			...remote,
			live: { doc: "doc", gen: 0, seq: 1 },
		};
		const seen: unknown[] = [];
		const live = {
			holds: () => false,
			absorb: async () => "cold",
			mark: async () => null,
			wrote: async () => {
				seen.push(a.journal.writeAt(VAULT_SPACE, "note.md"));
			},
		} as unknown as LiveNotes;

		await autoMergeOp({ ...a.deps(), live }, result, a.context());

		expect(seen).toEqual(["writing"]);
		expect(a.journal.pending(VAULT_SPACE)).toEqual([]);
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

describe("autoMergeOp on settings JSON", () => {
	const plugin = ".obsidian/plugins/sample";
	const json = (value: unknown) => JSON.stringify(value, null, 2);

	/** Both devices hold `base` at `path`, then b pushes `remote` and a writes `local` unpushed. */
	async function diverged(
		path: string,
		base: string,
		local: string,
		remote: string,
	) {
		const storage = new RevalidatingStorage();
		const [a, b] = [new Device("a", storage), new Device("b", storage)];
		for (const device of [a, b]) {
			device.settingsSync = { ...disabled, pluginConfigs: true };
		}
		a.adapter.putText(path, base);
		await a.push();
		await b.pull();
		b.adapter.putText(path, remote);
		await b.push();
		a.adapter.putText(path, local);
		return { a, b };
	}

	it("merges a plugin's settings by key, and both devices converge", async () => {
		const path = `${plugin}/data.json`;
		const { a, b } = await diverged(
			path,
			json({ theme: "light", size: 12 }),
			json({ theme: "dark", size: 12 }),
			json({ theme: "light", size: 14 }),
		);
		const result = await a.compare();
		expect(result.diff.conflicts.map((c) => c.path)).toEqual([path]);

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths).toEqual(new Set([path]));
		expect(a.text(path)).toBe(json({ theme: "dark", size: 14 }));
		await a.push();
		await b.pull();
		expect(b.text(path)).toBe(a.text(path));
		const after = await a.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.conflicts).toHaveLength(0);
	});

	it("leaves plugin code for the merge screen even when lines do not overlap", async () => {
		const path = `${plugin}/main.js`;
		const local = BASE.replace("one", "ONE");
		const { a } = await diverged(path, BASE, local, BASE.replace("six", "SIX"));
		const result = await a.compare();
		expect(result.diff.conflicts.map((c) => c.path)).toEqual([path]);

		const outcome = await autoMergeOp(a.deps(), result, a.context());

		expect(outcome.touchedPaths.size).toBe(0);
		expect(a.text(path)).toBe(local);
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
