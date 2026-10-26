import { createTestControllerHost } from "@tests/helpers/controller";
import {
	AFTER,
	BEFORE,
	behind,
	cutShort,
	device,
	isNote,
} from "@tests/helpers/cut-short";
import { killNextWrite } from "@tests/helpers/faults";
import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/crypto";
import { autoMergeOp } from "@/sync/auto-merge";
import { textToBytes } from "@/sync/content";
import { SyncController } from "@/sync/controller";
import { restoreCutShort, settleLanded } from "@/sync/cut-short";
import { compare } from "@/sync/engine";
import { type BaseStep, WriteJournal } from "@/sync/journal";
import type { LiveNotes } from "@/sync/live-notes";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";
import { batchAcceptRemoteOp } from "@/sync/operations/resolve";
import { pullPaths } from "@/sync/pull";
import { VAULT_SPACE } from "@/sync/space";
import type { SessionState } from "@/sync/types";

useEncryptionKey();
afterEach(() => vi.restoreAllMocks());

const THEIRS = BEFORE.replace("line 10", "line 10 remote");
const MERGED = AFTER.replace("line 10", "line 10 remote");
const MARK = { doc: "doc", gen: 0, seq: 3 };
const STAGING = ".obsidian/plugins/mdsync/staging";

const hashOf = (text: string) => sha256Hex(textToBytes(text));

async function restart(session: TestSession): Promise<void> {
	const adapter = session.adapter.asDataAdapter();
	session.journal = await WriteJournal.load(adapter, ".obsidian");
	await restoreCutShort(adapter, session.journal, [VAULT_SPACE]);
}

/** Rewrites the step the phone's cut-short write holds. */
function restep(phone: TestSession, change: Partial<BaseStep>): void {
	const intent = phone.journal.pending(VAULT_SPACE)[0]?.intent;
	if (!intent?.base) throw new Error("expected a base step");
	intent.base = { ...intent.base, ...change };
}

/** What `settleLanded` saves for the note. */
async function settledHashes(session: TestSession): Promise<unknown[]> {
	const saved: SessionState[] = [];
	await settleLanded(session.deps(), async (state) => {
		saved.push(state);
	});
	return saved.map(({ baseline }) => baseline?.files["note.md"]?.hash);
}

/** The phone's pull of AFTER was cut short, then the laptop took the note back to BEFORE. */
async function revertedMeanwhile(
	recover: (phone: TestSession) => Promise<void> = async () => undefined,
) {
	const [a, b] = pairedSessions();
	const laptop = device(a);
	const phone = new SyncController(createTestControllerHost(b));
	a.adapter.putText("note.md", BEFORE);
	await laptop();
	await phone.refreshAndAutoSync();
	a.adapter.putText("note.md", AFTER);
	await laptop();
	killNextWrite(b.adapter, isNote, "prefix");
	await phone.refreshAndAutoSync();
	await recover(b);
	a.adapter.putText("note.md", BEFORE);
	await laptop();
	return { a, b, laptop, phone };
}

/** `a` turned BEFORE into AFTER while `b` published THEIRS. */
async function conflicted(): Promise<TestSession> {
	const [a, b] = pairedSessions();
	a.adapter.putText("note.md", BEFORE);
	await pushPathsOp(a.deps(), await a.compare(), ["note.md"], a.context());
	b.adapter.putText("note.md", BEFORE);
	await b.adoptRemote();
	b.adapter.putText("note.md", THEIRS);
	await pushPathsOp(b.deps(), await b.compare(), ["note.md"], b.context());
	a.adapter.putText("note.md", AFTER);
	return a;
}

describe("a download finished on recovery", () => {
	it.each([
		["in the same run", undefined],
		["after a restart", restart],
	])(
		"gives the baseline its entry, so a change made elsewhere since is pulled, not undone (%s)",
		async (_, recover) => {
			const { a, b, laptop, phone } = await revertedMeanwhile(recover);
			await phone.refreshAndAutoSync();
			await laptop();
			expect([a.text("note.md"), b.text("note.md")]).toEqual([BEFORE, BEFORE]);
		},
	);

	it("lets the operation whose compare finished it write the note", async () => {
		const { b, phone } = await revertedMeanwhile();
		expect(await phone.pullPaths(["note.md"])).toEqual({ ok: true });
		expect(b.text("note.md")).toBe(BEFORE);
	});

	it("is settled by a refresh alone", async () => {
		const phone = await cutShort("prefix");
		const host = createTestControllerHost(phone);
		await new SyncController(host).refresh();
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
		const slot = host.getState().storages[phone.storage.identity()];
		expect(slot?.baseline?.files["note.md"]?.hash).toBe(await hashOf(AFTER));
	});

	it("leaves the journal only once the baseline it gave is saved", async () => {
		const phone = await cutShort("prefix");
		await phone.compare();
		// The persister keeps in memory a state whose write failed.
		const failing = async (state: SessionState) => {
			phone.state = state;
			throw new Error("disk full");
		};
		await expect(settleLanded(phone.deps(), failing)).rejects.toThrow();
		expect(phone.journal.pending(VAULT_SPACE)).toHaveLength(1);
		expect(await settledHashes(phone)).toEqual([await hashOf(AFTER)]);
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
	});

	it("is never rewritten over an edit made after it was finished", async () => {
		const phone = await cutShort("prefix");
		await phone.compare();
		phone.adapter.putText("note.md", AFTER.slice(0, 5));
		await restart(phone);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBeNull();
		const { diff } = await phone.compare();
		expect(phone.text("note.md")).toBe(AFTER.slice(0, 5));
		// Judged against what it downloaded, not as a conflict.
		const edited = diff.localChanges.map(({ path }) => path);
		expect([edited, diff.conflicts]).toEqual([["note.md"], []]);
	});

	it.each([
		["of another storage", { storage: "elsewhere" }],
		["of another vault", { vaultId: "elsewhere" }],
		["the baseline moved past", { from: "older" }],
	])("leaves out a step %s, and lets it go", async (_, change) => {
		const phone = await cutShort("prefix");
		restep(phone, change);
		const { diff } = await phone.compare();
		expect(diff.converged).toEqual(["note.md"]);
		const persist = vi.fn(async () => undefined);
		await settleLanded(phone.deps(), persist);
		expect(persist).not.toHaveBeenCalled();
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
	});
});

describe("an operation's download", () => {
	it("stays in the journal while its operation could not save the baseline", async () => {
		const phone = await behind();
		const lost = {
			...phone.context(),
			persistState: async () => {
				throw new Error("disk full");
			},
		};
		const result = await phone.compare();
		const pulling = pullPathsOp(phone.deps(), result, ["note.md"], lost);
		await expect(pulling).rejects.toThrow("disk full");
		await phone.compare();
		await restart(phone);
		expect(await settledHashes(phone)).toEqual([await hashOf(AFTER)]);
	});

	it("is listed as landed once its operation ends, so an edit before the next compare keeps its step", async () => {
		const phone = await behind();
		const host = createTestControllerHost(phone);
		host.persistState = async () => {
			throw new Error("disk full");
		};
		const pulled = await new SyncController(host).pullPaths(["note.md"]);
		expect(pulled).toMatchObject({ ok: false });
		phone.adapter.putText("note.md", `${AFTER}\nmine`);
		await restart(phone);
		const { diff } = await phone.compare();
		const edited = diff.localChanges.map(({ path }) => path);
		expect([edited, diff.conflicts]).toEqual([["note.md"], []]);
	});

	it.each([
		[
			"a pull",
			AFTER,
			async () => {
				const phone = await behind();
				const result = await phone.compare();
				await pullPathsOp(phone.deps(), result, ["note.md"], phone.context());
				return phone;
			},
		],
		[
			"an auto-merge",
			MERGED,
			async () => {
				const a = await conflicted();
				await autoMergeOp(a.deps(), await a.compare(), a.context());
				return a;
			},
		],
		[
			"accepting the remote side",
			THEIRS,
			async () => {
				const a = await conflicted();
				const notes = new Set(["note.md"]);
				await batchAcceptRemoteOp(
					a.deps(),
					await a.compare(),
					notes,
					a.context(),
				);
				return a;
			},
		],
	])("leaves the journal once %s saved the baseline", async (_, text, run) => {
		const session = await run();
		expect(session.text("note.md")).toBe(text);
		expect(session.journal.pending(VAULT_SPACE)).toEqual([]);
	});

	it("keeps no staged copy once it landed", async () => {
		const phone = await behind();
		await pullPaths(phone.deps(), await phone.compare(), ["note.md"]);
		expect(phone.journal.pending(VAULT_SPACE)).toHaveLength(1);
		expect((await phone.adapter.list(STAGING)).files).toEqual([]);
	});

	it("gives no step to a file moved here and edited there", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("a.md", BEFORE);
		await pushPathsOp(a.deps(), await a.compare(), ["a.md"], a.context());
		b.adapter.putText("a.md", BEFORE);
		await b.adoptRemote();
		await b.adapter.rename("a.md", "b.md");
		a.adapter.putText("a.md", AFTER);
		await pushPathsOp(a.deps(), await a.compare(), ["a.md"], a.context());
		await pullPaths(b.deps(), await b.compare(), ["a.md"]);
		expect(b.text("b.md")).toBe(AFTER);
		// The app gone before the pull saved its baseline: `b.md` is no remote deletion.
		const { diff } = await b.compare();
		expect(diff.remoteChanges.map(({ path }) => path)).not.toContain("b.md");
	});
});

describe("a merge finished on recovery", () => {
	it("stays this device's edit on top of the remote version", async () => {
		const a = await conflicted();
		killNextWrite(a.adapter, isNote, "prefix");
		const merging = autoMergeOp(a.deps(), await a.compare(), a.context());
		await expect(merging).rejects.toThrow("killed mid-write");
		const { diff } = await a.compare();
		expect(a.text("note.md")).toBe(MERGED);
		const edited = diff.localChanges.map(({ path }) => path);
		expect([edited, diff.conflicts]).toEqual([["note.md"], []]);
	});

	it("makes the room snapshot it grew from its merge base", async () => {
		const a = await conflicted();
		const result = await a.compare();
		const remote = result.remote?.files["note.md"];
		if (!result.remote || !remote) throw new Error("expected the remote note");
		result.remote.files["note.md"] = { ...remote, live: MARK };
		const wrote = vi.fn(async () => undefined);
		const live = {
			absorb: async () => "cold",
			mark: async () => null,
			holds: () => false,
			wrote,
		} as unknown as LiveNotes;
		killNextWrite(a.adapter, isNote, "prefix");
		const merging = autoMergeOp({ ...a.deps(), live }, result, a.context());
		await expect(merging).rejects.toThrow("killed mid-write");
		expect(wrote).not.toHaveBeenCalled();
		await compare({ ...a.deps(), live });
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, THEIRS);
	});
});
