import { createTestControllerHost } from "@tests/helpers/controller";
import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { SyncController } from "@/sync/controller";
import { pullPaths } from "@/sync/engine";
import type { LiveNotes } from "@/sync/live-notes";
import { pushPathsOp } from "@/sync/operations/push";

useEncryptionKey();

const CLEAN = { error: null, conflicts: 0, pendingLocal: 0, pendingRemote: 0 };

function device(session: TestSession) {
	const controller = new SyncController(createTestControllerHost(session));
	const sync = async () => {
		await controller.refreshAndAutoSync();
		await controller.refresh();
		return controller.getSnapshot();
	};
	return { adapter: session.adapter, controller, sync };
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
});
