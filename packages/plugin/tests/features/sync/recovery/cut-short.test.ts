import {
	AFTER,
	BEFORE,
	behind,
	cutShort,
	device,
	isNote,
} from "@tests/helpers/cut-short";
import { failIo, killNextWrite } from "@tests/helpers/faults";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import {
	pairedSessions,
	TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/core/crypto/cipher";
import { pullPaths } from "@/features/sync/apply/pull";
import { textToBytes } from "@/features/sync/changes/content";
import { compare } from "@/features/sync/engine";
import type { LiveNotes } from "@/features/sync/live-notes";
import { restoreCutShort } from "@/features/sync/recovery/cut-short";
import {
	type Intent,
	UnfinishedWriteError,
	WriteJournal,
} from "@/features/sync/recovery/journal";
import { VAULT_SPACE } from "@/features/sync/remote/space";

useEncryptionKey();
afterEach(() => vi.restoreAllMocks());

const TARGET = { hash: "h" };
const MARK = { doc: "doc", gen: 0, seq: 3 };
const STAGING = ".obsidian/plugins/mdsync/staging";

const isCopy = (path: string) => path.startsWith(`${STAGING}/`);

/** The phone, never synced, finds AFTER new on the remote. */
async function fresh(path: string): Promise<TestSession> {
	const [laptop, phone] = pairedSessions();
	laptop.adapter.putText(path, AFTER);
	await device(laptop)();
	return phone;
}

/** Pulls AFTER as a room snapshot to a closed note; returns what stopped it. */
async function pullMarked(
	phone: TestSession,
	wrote: LiveNotes["wrote"],
): Promise<unknown> {
	const result = await phone.compare();
	const remote = result.remote?.files["note.md"];
	if (!result.remote || !remote) throw new Error("expected the remote note");
	result.remote.files["note.md"] = { ...remote, live: MARK };
	const live = {
		holds: () => false,
		absorb: async () => "cold",
		mark: async () => null,
		wrote,
	} as unknown as LiveNotes;
	const pulled = await pullPaths({ ...phone.deps(), live }, result, [
		"note.md",
	]);
	return pulled.failed;
}

/** A marked write of AFTER that landed, the app gone before its release was saved. */
async function landed(): Promise<TestSession> {
	const session = new TestSession();
	session.adapter.putText("note.md", BEFORE);
	const bytes = textToBytes(AFTER);
	const target = { hash: await sha256Hex(bytes), live: MARK };
	const claims = await session.journal.claim(
		VAULT_SPACE,
		new Map([["note.md", target]]),
	);
	vi.spyOn(session.adapter, "remove").mockRejectedValueOnce(new Error("gone"));
	await session.journal.write(
		"note.md",
		claims.get("note.md") as Intent,
		bytes,
	);
	session.journal = await WriteJournal.load(
		session.adapter.asDataAdapter(),
		".obsidian",
	);
	return session;
}

describe("a pull write cut short", () => {
	it("never reaches the other devices as a truncation", async () => {
		const [a, b] = pairedSessions();
		const laptop = device(a);
		const phone = device(b);
		a.adapter.putText("note.md", BEFORE);
		await laptop();
		await phone();
		a.adapter.putText("note.md", AFTER);
		await laptop();
		killNextWrite(b.adapter, isNote, "prefix");
		await phone();
		await phone();
		await laptop();
		expect([a.text("note.md"), b.text("note.md")]).toEqual([AFTER, AFTER]);
	});

	it.each(["prefix", "nothing"] as const)(
		"is finished by the next compare when it left %s",
		async (leaves) => {
			const phone = await cutShort(leaves);
			const { diff } = await phone.compare();
			expect(phone.text("note.md")).toBe(AFTER);
			expect([diff.localChanges, diff.conflicts]).toEqual([[], []]);
			expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBeNull();
		},
	);

	it("is finished after a restart, from the journal on disk", async () => {
		const phone = await cutShort("prefix");
		phone.journal = await WriteJournal.load(
			phone.adapter.asDataAdapter(),
			".obsidian",
		);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBe("cut");
		await phone.compare();
		expect(phone.text("note.md")).toBe(AFTER);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBeNull();
	});

	it("is finished while the remote cannot be reached", async () => {
		const phone = await cutShort("prefix");
		vi.spyOn(phone.storage, "get").mockRejectedValue(new Error("offline"));
		await expect(phone.compare()).rejects.toThrow("offline");
		expect(phone.text("note.md")).toBe(AFTER);
	});

	it.each([
		["put back at load", AFTER.slice(0, 5), AFTER],
		["left alone at load when edited since", "mine", "mine"],
	])("is %s", async (_, disk, expected) => {
		const phone = await cutShort("prefix");
		phone.adapter.putText("note.md", disk);
		const adapter = phone.adapter.asDataAdapter();
		const journal = await WriteJournal.load(adapter, ".obsidian");
		await restoreCutShort(adapter, journal, [VAULT_SPACE]);
		expect(phone.text("note.md")).toBe(expected);
		// Its room waits for the compare, which saves the merge base.
		expect(journal.writeAt(VAULT_SPACE, "note.md")).toBe("cut");
	});

	it("leaves an edit made since alone", async () => {
		const phone = await cutShort("prefix");
		phone.adapter.putText("note.md", "mine");
		const { diff } = await phone.compare();
		expect(phone.text("note.md")).toBe("mine");
		expect(diff.conflicts.map(({ path }) => path)).toEqual(["note.md"]);
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
	});

	it("stays out of the diff while a room holds the note", async () => {
		const phone = await cutShort("prefix");
		const live = { holds: () => true } as unknown as LiveNotes;
		const { snapshot, diff } = await compare({ ...phone.deps(), live });
		expect(snapshot.skipped).toContainEqual(
			expect.objectContaining({ path: "note.md", reason: "unreadable" }),
		);
		expect([diff.localChanges, diff.conflicts]).toEqual([[], []]);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBe("cut");
	});

	it("stays out of the diff while its staged copy cannot be read", async () => {
		const phone = await cutShort("prefix");
		failIo(phone.adapter, isCopy);
		const { diff } = await phone.compare();
		expect([diff.localChanges, diff.conflicts]).toEqual([[], []]);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBe("cut");
	});

	it("stays out of the diff while its folder cannot be read", async () => {
		const phone = await cutShort("nothing", "dir/note.md");
		failIo(phone.adapter, (path) => path === "dir");
		const { diff } = await phone.compare();
		expect([diff.localChanges, diff.conflicts]).toEqual([[], []]);
		expect(phone.journal.writeAt(VAULT_SPACE, "dir/note.md")).toBe("cut");
	});

	it("refuses another write over it until it is finished", async () => {
		const phone = await cutShort("prefix");
		await expect(
			phone.journal.claim(VAULT_SPACE, new Map([["note.md", TARGET]])),
		).rejects.toThrow(UnfinishedWriteError);
	});
});

describe("a pull write", () => {
	it("leaves an edit saved while its copy was staged", async () => {
		const phone = await behind();
		const write = InMemoryAdapter.prototype.writeBinary.bind(phone.adapter);
		vi.spyOn(phone.adapter, "writeBinary").mockImplementation(
			async (path, data) => {
				await write(path, data);
				if (isCopy(path)) phone.adapter.putText("note.md", "typed meanwhile");
			},
		);
		const pulled = await pullPaths(phone.deps(), await phone.compare(), [
			"note.md",
		]);
		expect(phone.text("note.md")).toBe("typed meanwhile");
		expect(pulled.written.has("note.md")).toBe(false);
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
	});

	it("that landed before a restart still gives its room the merge base", async () => {
		const session = await landed();
		const wrote = vi.fn();
		const live = { holds: () => false, wrote } as unknown as LiveNotes;
		await compare({ ...session.deps(), live });
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, AFTER);
		expect(session.journal.pending(VAULT_SPACE)).toEqual([]);
	});

	it("of a room snapshot lets no room open on the note before its merge base is saved", async () => {
		const phone = await behind();
		const seen: unknown[] = [];
		await pullMarked(phone, async () => {
			seen.push(phone.journal.writeAt(VAULT_SPACE, "note.md"));
		});
		expect(seen).toEqual(["writing"]);
		expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBeNull();
	});

	it.each([
		["an overwrite", behind],
		["a new note", fresh],
	])(
		"of a room snapshot, %s whose merge base was not saved, is finished by the next compare",
		async (_, phoneOf) => {
			const phone = await phoneOf("note.md");
			const failed = await pullMarked(phone, async () => {
				throw new Error("disk full");
			});
			expect(failed).toMatchObject({ message: "disk full" });
			expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBe("cut");
			const wrote = vi.fn();
			const live = { holds: () => false, wrote } as unknown as LiveNotes;
			await compare({ ...phone.deps(), live });
			expect(wrote).toHaveBeenCalledWith("note.md", MARK, AFTER);
			expect(phone.journal.writeAt(VAULT_SPACE, "note.md")).toBeNull();
		},
	);

	it("gives its room what landed, not an edit saved since the scan", async () => {
		const session = await landed();
		const wrote = vi.fn();
		const holds = () => {
			session.adapter.putText("note.md", "typed since");
			return false;
		};
		const live = { holds, wrote } as unknown as LiveNotes;
		await compare({ ...session.deps(), live });
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, AFTER);
	});

	it("that landed gives its room the merge base though the scan could not read it", async () => {
		const session = await landed();
		const read = InMemoryAdapter.prototype.readBinary.bind(session.adapter);
		let failed = false;
		vi.spyOn(session.adapter, "readBinary").mockImplementation(async (path) => {
			if (path !== "note.md" || failed) return read(path);
			failed = true;
			throw new Error("EIO");
		});
		const wrote = vi.fn();
		const live = { holds: () => false, wrote } as unknown as LiveNotes;
		await compare({ ...session.deps(), live });
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, AFTER);
	});

	it("leaves a note whose room came after it was found cold", async () => {
		const phone = await behind();
		const live = {
			absorb: async () => "cold",
			mark: async () => null,
			holds: () => true,
		} as unknown as LiveNotes;
		const pulled = await pullPaths(
			{ ...phone.deps(), live },
			await phone.compare(),
			["note.md"],
		);
		expect(phone.text("note.md")).toBe(BEFORE);
		expect(pulled.written.has("note.md")).toBe(false);
		expect(phone.journal.pending(VAULT_SPACE)).toEqual([]);
	});
});

describe("WriteJournal", () => {
	it("tells a write under way from one cut short", async () => {
		const adapter = new InMemoryAdapter().asDataAdapter();
		const journal = new WriteJournal(adapter, ".obsidian");
		await journal.claim(VAULT_SPACE, new Map([["a.md", TARGET]]));
		expect(journal.writeAt(VAULT_SPACE, "a.md")).toBe("writing");
		const reloaded = await WriteJournal.load(adapter, ".obsidian");
		expect(reloaded.writeAt(VAULT_SPACE, "a.md")).toBe("cut");
	});

	it("unloaded, leaves its file to the next instance and starts no write", async () => {
		const phone = await behind();
		await pullPaths(phone.deps(), await phone.compare(), ["note.md"]);
		phone.journal.dispose();
		// The state save was dropped as well.
		await phone.journal.acknowledge(VAULT_SPACE);
		const adapter = phone.adapter.asDataAdapter();
		const next = await WriteJournal.load(adapter, ".obsidian");
		expect(next.pending(VAULT_SPACE)).toHaveLength(1);
		const claiming = phone.journal.claim(
			VAULT_SPACE,
			new Map([["a.md", TARGET]]),
		);
		await expect(claiming).rejects.toThrow("unloaded");
	});

	it("will not load as empty a journal it cannot read", async () => {
		const adapter = new InMemoryAdapter();
		await new WriteJournal(adapter.asDataAdapter(), ".obsidian").claim(
			VAULT_SPACE,
			new Map([["a.md", TARGET]]),
		);
		failIo(adapter, (path) => path.endsWith("/journal.json"));
		await expect(
			WriteJournal.load(adapter.asDataAdapter(), ".obsidian"),
		).rejects.toThrow("EIO");
	});

	it("clears staged copies no write names", async () => {
		const adapter = new InMemoryAdapter();
		const journal = new WriteJournal(adapter.asDataAdapter(), ".obsidian");
		const claims = await journal.claim(
			VAULT_SPACE,
			new Map([["a.md", TARGET]]),
		);
		vi.spyOn(adapter, "remove").mockRejectedValueOnce(new Error("EIO"));
		await journal.write("a.md", claims.get("a.md") as Intent, textToBytes("a"));
		await journal.save();
		const staged = async () => (await adapter.list(STAGING)).files;
		expect(await staged()).toHaveLength(1);
		await WriteJournal.load(adapter.asDataAdapter(), ".obsidian");
		expect(await staged()).toEqual([]);
	});

	it("finds a write where its share moved since", async () => {
		const adapter = new InMemoryAdapter().asDataAdapter();
		await new WriteJournal(adapter, ".obsidian").claim(
			{ id: "share", root: "Old" },
			new Map([["Old/a.md", TARGET]]),
		);
		const journal = await WriteJournal.load(adapter, ".obsidian");
		const moved = { id: "share", root: "New" };
		expect(journal.writeAt(moved, "New/a.md")).toBe("cut");
		await expect(
			journal.claim(moved, new Map([["New/a.md", TARGET]])),
		).rejects.toThrow(UnfinishedWriteError);
	});

	it("hands a write on to the share its folder became", async () => {
		const journal = new WriteJournal(
			new InMemoryAdapter().asDataAdapter(),
			".obsidian",
		);
		await journal.claim(VAULT_SPACE, new Map([["Folder/a.md", TARGET]]));
		const share = { id: "share", root: "Folder" };
		journal.adopt([VAULT_SPACE, share]);
		expect([
			journal.writeAt(share, "Folder/a.md"),
			journal.writeAt(VAULT_SPACE, "Folder/a.md"),
		]).toEqual(["writing", null]);
	});

	it("hands a closed share's writes on from where it last had them", async () => {
		const journal = new WriteJournal(
			new InMemoryAdapter().asDataAdapter(),
			".obsidian",
		);
		await journal.claim(
			{ id: "share", root: "Old" },
			new Map([["Old/a.md", TARGET]]),
		);
		journal.adopt([VAULT_SPACE, { id: "share", root: "New" }]);
		journal.adopt([VAULT_SPACE]);
		const adopted = journal
			.pending(VAULT_SPACE)
			.map(({ path, intent }) => [path, intent.root]);
		expect(adopted).toEqual([["New/a.md", ""]]);
	});
});
