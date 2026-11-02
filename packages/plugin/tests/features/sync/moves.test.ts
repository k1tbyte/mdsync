import { createTestControllerHost } from "@tests/helpers/controller";
import type { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import { pullPaths } from "@/features/sync/apply/pull";
import { REMOTE_OBJECTS_PREFIX } from "@/features/sync/constants";
import { SyncController } from "@/features/sync/controller";
import type { LiveNotes } from "@/features/sync/live-notes";
import { pushPathsOp } from "@/features/sync/operations/push";

useEncryptionKey();

const CLEAN = { error: null, conflicts: 0, pendingLocal: 0, pendingRemote: 0 };

function device(session: TestSession) {
	const host = createTestControllerHost(session);
	const controller = new SyncController(host);
	const sync = async () => {
		await controller.refreshAndAutoSync();
		await controller.refresh();
		return controller.getSnapshot();
	};
	return { adapter: session.adapter, controller, host, sync };
}

/** Two devices of one vault, both synced with `files`. */
async function synced(files: Record<string, string>) {
	const [a, b] = pairedSessions();
	const laptop = device(a);
	const phone = device(b);
	for (const [path, text] of Object.entries(files)) {
		laptop.adapter.putText(path, text);
	}
	await laptop.sync();
	await phone.sync();
	return { laptop, phone, storage: a.storage };
}

describe("moves across devices", () => {
	it("renames a file moved on another device, without downloading it again", async () => {
		const { laptop, phone, storage } = await synced({ "a.md": "A" });
		await laptop.adapter.asDataAdapter().rename("a.md", "b.md");
		await laptop.sync();

		const get = vi.spyOn(storage, "get");
		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.hasFile("a.md"),
			phone.adapter.readText("b.md"),
		]).toEqual([false, "A"]);
		const objects = get.mock.calls.filter(([key]) =>
			key.startsWith(REMOTE_OBJECTS_PREFIX),
		);
		expect(objects).toEqual([]);
	});

	it("diffs a moved file against the text it left", async () => {
		const { laptop } = await synced({ "a.md": "A" });
		await laptop.adapter.asDataAdapter().rename("a.md", "b.md");
		await laptop.controller.refresh();

		const model = await laptop.controller.fileDiffs.getFileDiff("b.md");
		expect(model).toMatchObject({
			path: "b.md",
			movedFrom: "a.md",
			leftText: "A",
			rightText: "A",
		});
	});

	it("counts a move as one change on both sides", async () => {
		const { laptop, phone } = await synced({ "a.md": "A", "c.md": "C" });
		await laptop.adapter.asDataAdapter().rename("a.md", "b.md");
		await laptop.adapter.asDataAdapter().remove("c.md");
		await laptop.controller.refresh();
		expect(laptop.controller.getSnapshot().pendingLocal).toBe(2);

		await laptop.sync();
		await phone.controller.refresh();
		expect(phone.controller.getSnapshot().pendingRemote).toBe(2);
	});

	it("carries an edit made here to where the file moved", async () => {
		const { laptop, phone } = await synced({ "a.md": "A" });
		phone.adapter.putText("a.md", "A mine");
		await laptop.adapter.asDataAdapter().rename("a.md", "b.md");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect(await laptop.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.hasFile("a.md"),
			phone.adapter.readText("b.md"),
			laptop.adapter.readText("b.md"),
		]).toEqual([false, "A mine", "A mine"]);
	});

	it("brings their edit into the file moved here", async () => {
		const { laptop, phone } = await synced({ "a.md": "A" });
		laptop.adapter.putText("a.md", "A theirs");
		await laptop.sync();
		await phone.adapter.asDataAdapter().rename("a.md", "b.md");

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect(await laptop.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.readText("b.md"),
			laptop.adapter.hasFile("a.md"),
			laptop.adapter.readText("b.md"),
		]).toEqual(["A theirs", false, "A theirs"]);
	});

	it("pushes and reverts a move whole when one of its paths is asked", async () => {
		const { laptop, phone } = await synced({ "a.md": "A", "c.md": "C" });
		const disk = laptop.adapter.asDataAdapter();
		await disk.rename("a.md", "b.md");
		await disk.rename("c.md", "d.md");
		await laptop.controller.refresh();
		await laptop.controller.revertPaths(["d.md"]);
		await laptop.controller.pushPaths(["b.md"]);

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.hasFile("a.md"),
			phone.adapter.readText("b.md"),
			laptop.adapter.readText("c.md"),
			laptop.adapter.hasFile("d.md"),
		]).toEqual([false, "A", "C", false]);
	});

	it("leaves no emptied folder behind to be published back", async () => {
		const { laptop, phone } = await synced({
			"Old/x.md": "X",
			"Old/deep/y.md": "Y",
			"Keep/z.md": "Z",
		});
		const disk = laptop.adapter.asDataAdapter();
		await disk.mkdir("New/deep");
		await disk.rename("Old/x.md", "New/x.md");
		await disk.rename("Old/deep/y.md", "New/deep/y.md");
		await disk.rmdir("Old", true);
		await disk.rmdir("Keep", true);
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		const there = phone.adapter.asDataAdapter();
		expect([
			await there.exists("Old"),
			await there.exists("Keep"),
			phone.adapter.readText("New/deep/y.md"),
		]).toEqual([false, false, "Y"]);
		expect(await laptop.sync()).toMatchObject(CLEAN);
		expect(await laptop.adapter.asDataAdapter().exists("Old")).toBe(false);
	});
});

describe("folders a pull leaves holding files", () => {
	it("keeps the files beside a deletion it pulls", async () => {
		const { laptop, phone } = await synced({
			"Notes/a.md": "A",
			"Notes/deep/b.md": "B",
			"Notes/deep/gone.md": "G",
		});
		await laptop.adapter.asDataAdapter().remove("Notes/deep/gone.md");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.readText("Notes/a.md"),
			phone.adapter.readText("Notes/deep/b.md"),
			phone.adapter.hasFile("Notes/deep/gone.md"),
		]).toEqual(["A", "B", false]);
		expect(await laptop.sync()).toMatchObject(CLEAN);
		expect(laptop.adapter.readText("Notes/deep/b.md")).toBe("B");
	});

	it("keeps the files beside a move it pulls", async () => {
		const { laptop, phone } = await synced({
			"Notes/a.md": "A",
			"Notes/b.md": "B",
		});
		await laptop.adapter.asDataAdapter().rename("Notes/a.md", "Notes/c.md");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.readText("Notes/b.md"),
			phone.adapter.readText("Notes/c.md"),
		]).toEqual(["B", "A"]);
	});

	it("keeps a file pulled into a folder that was empty", async () => {
		const { laptop, phone } = await synced({ "a.md": "A" });
		await laptop.adapter.asDataAdapter().mkdir("Inbox");
		laptop.adapter.putText("a.md", "A2");
		await laptop.sync();
		await phone.sync();
		expect(await phone.adapter.asDataAdapter().exists("Inbox")).toBe(true);
		laptop.adapter.putText("Inbox/new.md", "N");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect(phone.adapter.readText("Inbox/new.md")).toBe("N");
	});
});

describe("a move pulled from a stale compare", () => {
	it("never lands over a file that appeared at its new path", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("a.md", "A");
		const laptop = device(a);
		await laptop.sync();
		await b.adoptRemote();
		b.adapter.putText("a.md", "A");
		await a.adapter.asDataAdapter().rename("a.md", "b.md");
		await laptop.sync();

		const stale = await b.compare();
		expect(stale.diff.moves).toEqual([
			{ from: "a.md", to: "b.md", side: "remote" },
		]);
		b.adapter.putText("b.md", "mine");
		const pulled = await pullPaths(b.deps(), stale, ["a.md", "b.md"]);
		expect([...pulled.written.keys()]).toEqual([]);
		expect([b.text("a.md"), b.text("b.md")]).toEqual(["A", "mine"]);
	});

	it("never lands a recasing over another file at the new casing", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("a.md", "A");
		const laptop = device(a);
		await laptop.sync();
		await b.adoptRemote();
		b.adapter.putText("a.md", "A");
		await a.adapter.asDataAdapter().rename("a.md", "A.md");
		await laptop.sync();

		const stale = await b.compare();
		b.adapter.putText("A.md", "mine");
		const pulled = await pullPaths(b.deps(), stale, ["a.md", "A.md"]);
		expect([...pulled.written.keys()]).toEqual([]);
		expect([b.text("a.md"), b.text("A.md")]).toEqual(["A", "mine"]);
	});
});

/** Obsidian mobile on a case-blind disk: another casing of a name it holds is taken, even the file's own. */
function caseBlindRename(disk: InMemoryAdapter): void {
	const rename = disk.rename.bind(disk);
	vi.spyOn(disk, "rename").mockImplementation(async (from, to) => {
		const slash = to.lastIndexOf("/");
		const { files } = await disk.list(slash > 0 ? to.slice(0, slash) : "");
		if (files.some((path) => path.toLowerCase() === to.toLowerCase())) {
			throw new Error("Destination file already exists!");
		}
		return rename(from, to);
	});
}

describe("a recasing on a case-blind phone", () => {
	it("pulls it with the rest of the pull", async () => {
		const { laptop, phone } = await synced({
			"notes/linkding.md": "L",
			"notes/other.md": "O",
		});
		caseBlindRename(phone.adapter);
		await laptop.adapter
			.asDataAdapter()
			.rename("notes/linkding.md", "notes/Linkding.md");
		laptop.adapter.putText("notes/other.md", "O2");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			(await phone.adapter.list("notes")).files,
			phone.adapter.readText("notes/Linkding.md"),
			phone.adapter.readText("notes/other.md"),
		]).toEqual([["notes/other.md", "notes/Linkding.md"], "L", "O2"]);
	});

	it("reverts one made here", async () => {
		const { phone } = await synced({ "note.md": "N" });
		caseBlindRename(phone.adapter);
		await phone.adapter.asDataAdapter().remove("note.md");
		phone.adapter.putText("Note.md", "N");
		await phone.controller.refresh();

		await phone.controller.revertPaths(["Note.md"]);

		expect(phone.controller.getSnapshot()).toMatchObject(CLEAN);
		expect((await phone.adapter.list("")).files).toEqual(["note.md"]);
	});

	it("steps around a file holding the step's name", async () => {
		const { laptop, phone } = await synced({
			"note.md": "N",
			"note.mdsync-recase.md": "S",
		});
		caseBlindRename(phone.adapter);
		await laptop.adapter.asDataAdapter().rename("note.md", "Note.md");
		await laptop.sync();

		expect(await phone.sync()).toMatchObject(CLEAN);
		expect([
			phone.adapter.readText("Note.md"),
			phone.adapter.readText("note.mdsync-recase.md"),
		]).toEqual(["N", "S"]);
	});
});

describe("a move that cannot land", () => {
	it("waits while the rest of the pull lands", async () => {
		const { laptop, phone } = await synced({ "a.md": "A", "other.md": "O" });
		await laptop.adapter.asDataAdapter().rename("a.md", "b.md");
		laptop.adapter.putText("other.md", "O2");
		await laptop.sync();
		vi.spyOn(phone.adapter, "rename").mockRejectedValueOnce(
			new Error("EACCES"),
		);

		const first = await phone.sync();
		expect([
			first.pendingRemote,
			phone.adapter.readText("a.md"),
			phone.adapter.readText("other.md"),
		]).toEqual([1, "A", "O2"]);
		expect(phone.host.logInfo).toHaveBeenCalledWith(
			expect.anything(),
			"Pulled 1 file(s) (2 B).",
			["other.md"],
		);
		expect(await phone.sync()).toMatchObject(CLEAN);
		expect(phone.adapter.readText("b.md")).toBe("A");
	});

	it("stops the pull when a recasing is left halfway, even with a new file at its old name", async () => {
		const { laptop, phone } = await synced({ "note.md": "N" });
		await laptop.adapter.asDataAdapter().rename("note.md", "Note.md");
		await laptop.sync();
		const rename = phone.adapter.rename.bind(phone.adapter);
		vi.spyOn(phone.adapter, "rename")
			.mockRejectedValueOnce(new Error("Destination file already exists!"))
			.mockImplementationOnce(async (from, to) => {
				await rename(from, to);
				phone.adapter.putText("note.md", "new");
			})
			.mockRejectedValue(new Error("EIO"));

		await phone.controller.refreshAndAutoSync();

		expect(phone.controller.getSnapshot().error).toContain(
			'"note.md" was left as "note.mdsync-recase.md"',
		);
	});
});

describe("a move whose note a room has not settled", () => {
	it("waits whole instead of publishing the old path's deletion", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("a.md", "A");
		await pushPathsOp(a.deps(), await a.compare(), ["a.md"], a.context());
		await a.adapter.asDataAdapter().rename("a.md", "b.md");
		const live: LiveNotes = {
			mark: async (path) => (path === "b.md" ? "later" : null),
			absorb: async () => "cold",
			wrote: async () => undefined,
			holds: () => false,
			kept: () => undefined,
		};

		const result = await a.compare();
		const outcome = await pushPathsOp(
			{ ...a.deps(), live },
			result,
			["b.md"],
			a.context(),
		);
		expect(outcome.newRemote).toBe(result.remote);
	});

	it("waits when a room opens on the note moved here while their edit downloads", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("a.md", "A");
		await pushPathsOp(a.deps(), await a.compare(), ["a.md"], a.context());
		b.adapter.putText("a.md", "A");
		await b.adoptRemote();
		await b.adapter.asDataAdapter().rename("a.md", "b.md");
		a.adapter.putText("a.md", "A theirs");
		await pushPathsOp(a.deps(), await a.compare(), ["a.md"], a.context());
		let opened = false;
		const live: LiveNotes = {
			mark: async () => null,
			absorb: async () => "cold",
			wrote: async () => undefined,
			holds: (path) => opened && path === "b.md",
			kept: () => undefined,
		};
		const result = await b.compare();
		const get = b.storage.get.bind(b.storage);
		vi.spyOn(b.storage, "get").mockImplementation(async (key) => {
			if (key.startsWith(REMOTE_OBJECTS_PREFIX)) opened = true;
			return get(key);
		});

		await pullPaths({ ...b.deps(), live }, result, ["a.md"]);
		expect(b.text("b.md")).toBe("A");
	});
});
