import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { compare, pullPaths } from "@/sync/engine";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	keepBothConflictOp,
	saveMergedOp,
} from "@/sync/operations/resolve";
import { revertPathsOp } from "@/sync/operations/revert";
import { recomputeAfterWrite } from "@/sync/session-state";
import { createIgnoreMatcher } from "@/vault/ignore";
import { createScopePolicy } from "@/vault/scope";

useEncryptionKey();

async function syncedPair(
	files: Record<string, string>,
): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	for (const [path, text] of Object.entries(files))
		a.adapter.putText(path, text);
	const first = await a.compare();
	await pushPathsOp(
		a.deps(),
		first,
		first.diff.localChanges.map((c) => c.path),
		a.context(),
	);
	for (const [path, text] of Object.entries(files))
		b.adapter.putText(path, text);
	await b.adoptRemote();
	return [a, b];
}

describe("batch operations", () => {
	it("a partial push does not adopt unpulled remote changes as baseline", async () => {
		const [a, b] = await syncedPair({
			"mine.md": "mine\n",
			"theirs.md": "theirs\n",
		});

		b.adapter.putText("theirs.md", "theirs, edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["theirs.md"], b.context());

		a.adapter.putText("mine.md", "mine, edited by A\n");
		const aResult = await a.compare();
		expect(aResult.diff.remoteChanges.map((c) => c.path)).toEqual([
			"theirs.md",
		]);
		const outcome = await pushPathsOp(
			a.deps(),
			aResult,
			["mine.md"],
			a.context(),
		);

		// theirs.md must remain a remote change; adopting the published manifest would revert B's work.
		const recomputed = recomputeAfterWrite(
			aResult,
			a.state,
			outcome,
			a.deps().scope,
		);
		expect(recomputed.diff.remoteChanges.map((c) => c.path)).toEqual([
			"theirs.md",
		]);
		expect(recomputed.diff.localChanges).toHaveLength(0);
	});

	it("keep-local resolves a delete-versus-edit conflict by publishing the delete", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		b.adapter.putText("note.md", "edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		await a.adapter.remove("note.md");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await batchKeepLocalOp(
			a.deps(),
			aResult,
			new Set(["note.md"]),
			a.context(),
		);

		expect(outcome.newRemote?.files["note.md"]).toBeUndefined();
		expect(outcome.localEntries?.get("note.md")).toBeNull();
	});

	it("accept-remote resolves an edit-versus-delete conflict by deleting locally", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		await b.adapter.remove("note.md");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "edited by A\n");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await batchAcceptRemoteOp(
			a.deps(),
			aResult,
			new Set(["note.md"]),
			a.context(),
		);

		expect(await a.adapter.exists("note.md")).toBe(false);
		expect(outcome.localEntries?.get("note.md")).toBeNull();
		expect(a.state.baseline?.files["note.md"]).toBeUndefined();
	});

	it("pull records the mtime it wrote, so the next scan does not re-hash", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		a.adapter.putText("note.md", "changed by A\n");
		const aResult = await a.compare();
		await pushPathsOp(a.deps(), aResult, ["note.md"], a.context());

		const bResult = await b.compare();
		await pullPathsOp(b.deps(), bResult, ["note.md"], b.context());

		const stat = await b.adapter.stat("note.md");
		expect(b.state.hashCache["note.md"]?.mtime).toBe(stat?.mtime);
		const after = await b.compare();
		expect(after.diff.localChanges).toHaveLength(0);
		expect(after.diff.remoteChanges).toHaveLength(0);
	});

	it("advances the baseline only for the paths it actually wrote", async () => {
		const [a, b] = await syncedPair({
			"mine.md": "mine\n",
			"theirs.md": "t\n",
		});

		b.adapter.putText("theirs.md", "edited by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["theirs.md"], b.context());

		a.adapter.putText("mine.md", "edited by A\n");
		const aResult = await a.compare();
		const mineBefore = a.state.baseline?.files["mine.md"]?.hash;

		// mine.md is local, not a remote change this pull can write; asking for it must not move its baseline.
		const pulled = await pullPaths(a.deps(), aResult, ["mine.md", "theirs.md"]);

		expect([...pulled.written.keys()]).toEqual(["theirs.md"]);
		expect(pulled.baseline.files["mine.md"]?.hash).toBe(mineBefore);
		expect(pulled.baseline.files["theirs.md"]?.hash).toBe(
			aResult.remote?.files["theirs.md"]?.hash,
		);
	});

	it.each([
		["accept-remote", batchAcceptRemoteOp],
		["keep-local", batchKeepLocalOp],
	])(
		"%s does not adopt an empty folder only the remote has",
		async (_, resolve) => {
			const [a, b] = await syncedPair({ "note.md": "shared\n" });
			await b.adapter.mkdir("EmptyFolder");
			b.adapter.putText("note.md", "edited by B\n");
			const bResult = await b.compare();
			await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

			a.adapter.putText("note.md", "edited by A\n");
			const aResult = await a.compare();
			await resolve(a.deps(), aResult, new Set(["note.md"]), a.context());

			// The folder is not on A's disk: listed in the baseline, the next push would delete it.
			expect(a.state.baseline?.folders ?? []).toEqual([]);
		},
	);

	it("two pushes without a pull keep an empty folder only the remote has", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		await b.adapter.mkdir("EmptyFolder");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, [], b.context());

		for (const text of ["first edit\n", "second edit\n"]) {
			a.adapter.putText("note.md", text);
			const result = await a.compare();
			const outcome = await pushPathsOp(
				a.deps(),
				result,
				["note.md"],
				a.context(),
			);
			expect(outcome.newRemote?.folders).toEqual(["EmptyFolder"]);
		}
		expect(a.state.baseline?.folders ?? []).toEqual([]);
	});

	it("a push records the empty folders it published from disk", async () => {
		const [a] = await syncedPair({ "note.md": "shared\n" });
		await a.adapter.mkdir("Mine");
		a.adapter.putText("note.md", "edited\n");
		const result = await a.compare();
		await pushPathsOp(a.deps(), result, ["note.md"], a.context());

		// So a later remote deletion of the folder removes it here too.
		expect(a.state.baseline?.folders).toEqual(["Mine"]);
	});

	it("a pull does not record an empty folder this device's scope hides", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		await b.adapter.mkdir("Private");
		b.adapter.putText("note.md", "edited by B\n");
		await pushPathsOp(b.deps(), await b.compare(), ["note.md"], b.context());

		const scope = createScopePolicy({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			configDir: ".obsidian",
			localIgnore: createIgnoreMatcher("Private/"),
		});
		const deps = () => ({ ...a.deps(), scope });
		await pullPathsOp(deps(), await compare(deps()), ["note.md"], a.context());
		a.adapter.putText("note.md", "edited by A\n");
		const outcome = await pushPathsOp(
			deps(),
			await compare(deps()),
			["note.md"],
			a.context(),
		);

		// The folder never reached A's disk, so A's push must not publish it as deleted.
		expect(outcome.newRemote?.folders).toEqual(["Private"]);
	});

	it("revert restores the baseline content and reports what it wrote", async () => {
		const [a] = await syncedPair({ "note.md": "original\n" });
		a.adapter.putText("note.md", "scribbled over\n");
		const result = await a.compare();

		const outcome = await revertPathsOp(
			a.deps(),
			result,
			["note.md"],
			a.context(),
		);

		expect(a.text("note.md")).toBe("original\n");
		expect(outcome.localEntries?.get("note.md")?.hash).toBe(
			a.state.baseline?.files["note.md"]?.hash,
		);
	});

	it("revert moves a file that never synced to the trash, not out of existence", async () => {
		const [a] = await syncedPair({ "note.md": "original\n" });
		a.adapter.putText("draft.md", "only here\n");
		const result = await a.compare();

		await revertPathsOp(a.deps(), result, ["draft.md"], a.context());

		expect(a.adapter.hasFile("draft.md")).toBe(false);
		expect(a.text(".trash/draft.md")).toBe("only here\n");
	});

	it("push refuses while any conflict is unresolved", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		b.adapter.putText("note.md", "by B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "by A\n");
		const aResult = await a.compare();
		await expect(
			pushPathsOp(a.deps(), aResult, ["note.md"], a.context()),
		).rejects.toThrow(/conflicts/);
	});

	it("keep-both refuses a remote deletion: there is no version to park", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		await b.adapter.remove("note.md");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "local edit\n");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		await expect(
			keepBothConflictOp(a.deps(), aResult, "note.md", a.context()),
		).rejects.toThrow(/deleted remotely/);
		expect(a.text("note.md")).toBe("local edit\n");
	});

	it("keep-both parks the remote version beside the file and publishes only the local side", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });

		b.adapter.putText("note.md", "remote edit\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());

		a.adapter.putText("note.md", "local edit\n");
		const aResult = await a.compare();
		expect(aResult.diff.conflicts.map((c) => c.path)).toEqual(["note.md"]);

		const outcome = await keepBothConflictOp(
			a.deps(),
			aResult,
			"note.md",
			a.context(),
		);

		// The conflict resolves by publishing the local content.
		expect(a.text("note.md")).toBe("local edit\n");
		expect(outcome.newRemote?.files["note.md"]).toBeDefined();

		// The remote version survives as a conflict copy, unpublished by this op.
		const listed = await a.adapter.list("");
		const copy = listed.files.find((p) => p.startsWith("note (conflict from "));
		expect(copy).toBeDefined();
		if (!copy) return;
		expect(a.text(copy)).toBe("remote edit\n");
		expect(outcome.newRemote?.files[copy]).toBeUndefined();

		// The copy is an ordinary new local file: it publishes with the next push.
		const after = await a.compare();
		expect(after.diff.localChanges.map((c) => c.path)).toEqual([copy]);
		expect(after.diff.conflicts).toHaveLength(0);
	});
});

describe("saving a merge resolution", () => {
	const SHARED = "one\ntwo\nthree\nfour\nfive\nsix\n";

	async function conflicted() {
		const [a, b] = await syncedPair({ "note.md": SHARED });
		b.adapter.putText("note.md", SHARED.replace("one", "ONE"));
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());
		a.adapter.putText("note.md", SHARED.replace("six", "SIX"));
		const result = await a.compare();
		const [conflict] = result.diff.conflicts;
		if (!conflict) throw new Error("expected a conflict");
		const expected = {
			localHash: conflict.localHash,
			remoteHash: conflict.remoteHash,
		};
		return { a, b, result, expected };
	}

	const merged = SHARED.replace("one", "ONE").replace("six", "SIX");

	it("writes the merge and publishes it when both sides are still the ones it was made from", async () => {
		const { a, result, expected } = await conflicted();

		const outcome = await saveMergedOp(
			a.deps(),
			result,
			{ path: "note.md", content: merged, expected },
			a.context(),
		);

		expect(a.text("note.md")).toBe(merged);
		expect(outcome.newRemote?.files["note.md"]).toBeDefined();
	});

	it("refuses, leaving the file alone, when the remote moved since the merge was opened", async () => {
		const { a, b, expected } = await conflicted();
		b.adapter.putText("note.md", SHARED.replace("one", "ONE").concat("more\n"));
		const again = await b.compare();
		await pushPathsOp(b.deps(), again, ["note.md"], b.context());
		const result = await a.compare();

		await expect(
			saveMergedOp(
				a.deps(),
				result,
				{ path: "note.md", content: merged, expected },
				a.context(),
			),
		).rejects.toThrow(/changed since the merge was opened/);
		expect(a.text("note.md")).toBe(SHARED.replace("six", "SIX"));
	});

	it("refuses when the local file changed since the merge was opened", async () => {
		const { a, expected } = await conflicted();
		a.adapter.putText("note.md", "typed meanwhile\n");
		const result = await a.compare();

		await expect(
			saveMergedOp(
				a.deps(),
				result,
				{ path: "note.md", content: merged, expected },
				a.context(),
			),
		).rejects.toThrow(/changed since the merge was opened/);
		expect(a.text("note.md")).toBe("typed meanwhile\n");
	});

	it("refuses when the conflict is gone", async () => {
		const { a, expected } = await conflicted();
		a.adapter.putText("note.md", SHARED.replace("one", "ONE"));
		const result = await a.compare();

		await expect(
			saveMergedOp(
				a.deps(),
				result,
				{ path: "note.md", content: merged, expected },
				a.context(),
			),
		).rejects.toThrow(/changed since the merge was opened/);
	});
});

describe("a pull of a file edited after the scan", () => {
	async function remoteChanged(change: "edit" | "delete") {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		if (change === "edit") b.adapter.putText("note.md", "from B\n");
		else await b.adapter.remove("note.md");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());
		return { a, result: await a.compare() };
	}

	it("keeps the edit instead of overwriting it", async () => {
		const { a, result } = await remoteChanged("edit");
		a.adapter.putText("note.md", "typed while downloading\n");

		const pulled = await pullPaths(a.deps(), result, ["note.md"]);

		expect(a.text("note.md")).toBe("typed while downloading\n");
		expect(pulled.written.has("note.md")).toBe(false);
	});

	it("keeps the edit instead of deleting the file", async () => {
		const { a, result } = await remoteChanged("delete");
		a.adapter.putText("note.md", "typed while downloading\n");

		const pulled = await pullPaths(a.deps(), result, ["note.md"]);

		expect(a.text("note.md")).toBe("typed while downloading\n");
		expect(pulled.written.has("note.md")).toBe(false);
	});

	it("writes a file nobody touched since the scan", async () => {
		const { a, result } = await remoteChanged("edit");

		const pulled = await pullPaths(a.deps(), result, ["note.md"]);

		expect(a.text("note.md")).toBe("from B\n");
		expect(pulled.written.has("note.md")).toBe(true);
	});

	it("keeps an edit to a file moved here when the remote edit of its old path arrives", async () => {
		const { a } = await remoteChanged("edit");
		await a.adapter.rename("note.md", "moved.md");
		const result = await a.compare();
		expect(result.diff.moves).toMatchObject([
			{ from: "note.md", to: "moved.md", side: "local" },
		]);
		a.adapter.putText("moved.md", "typed while downloading\n");

		const pulled = await pullPaths(a.deps(), result, ["moved.md"]);

		expect(a.text("moved.md")).toBe("typed while downloading\n");
		expect(pulled.written.has("moved.md")).toBe(false);
	});

	it("refuses to accept the remote side over an edit made after the compare", async () => {
		const [a, b] = await syncedPair({ "note.md": "shared\n" });
		b.adapter.putText("note.md", "from B\n");
		const bResult = await b.compare();
		await pushPathsOp(b.deps(), bResult, ["note.md"], b.context());
		a.adapter.putText("note.md", "from A\n");
		const result = await a.compare();
		a.adapter.putText("note.md", "typed after the compare\n");

		await expect(
			batchAcceptRemoteOp(a.deps(), result, new Set(["note.md"]), a.context()),
		).rejects.toThrow(/changed since the compare/);
		expect(a.text("note.md")).toBe("typed after the compare\n");
	});
});
