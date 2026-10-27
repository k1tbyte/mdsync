import { createTestControllerHost } from "@tests/helpers/controller";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/core/crypto/cipher";
import { pullPaths } from "@/features/sync/apply/pull";
import { textToBytes } from "@/features/sync/changes/content";
import { SyncController } from "@/features/sync/controller";
import { objectKey } from "@/features/sync/remote/manifest";

useEncryptionKey();
afterEach(() => vi.restoreAllMocks());

function device(session: TestSession) {
	const controller = new SyncController(createTestControllerHost(session));
	return {
		/** No compare after: one would settle a file that matches the remote, closing the window. */
		auto: () => controller.refreshAndAutoSync(),
		sync: async () => {
			await controller.refreshAndAutoSync();
			await controller.refresh();
		},
	};
}

/** The network drops on the object holding `text`. */
async function unreachable(session: TestSession, text: string): Promise<void> {
	const key = objectKey(await sha256Hex(textToBytes(text)));
	const get = session.storage.get.bind(session.storage);
	vi.spyOn(session.storage, "get").mockImplementation(async (name, ...rest) => {
		if (name === key) throw new Error("network down");
		return get(name, ...rest);
	});
}

describe("a batch stopped by an error", () => {
	it("keeps the pulled files that landed: a change made there since stands", async () => {
		const [a, b] = pairedSessions();
		const laptop = device(a);
		const phone = device(b);
		a.adapter.putText("n0.md", "base 0");
		a.adapter.putText("n1.md", "base 1");
		await laptop.sync();
		await phone.sync();
		a.adapter.putText("n0.md", "base 0\nX");
		a.adapter.putText("n1.md", "base 1\nY");
		await laptop.sync();
		await unreachable(a, "base 1\nY");
		await phone.auto();
		vi.restoreAllMocks();
		expect(b.text("n0.md")).toBe("base 0\nX");
		// Taken back before the phone syncs again.
		a.adapter.putText("n0.md", "base 0");
		await laptop.sync();
		await phone.sync();
		await laptop.sync();
		expect([a.text("n0.md"), b.text("n0.md")]).toEqual(["base 0", "base 0"]);
	});

	it("keeps the merges that landed: a change made there since stands", async () => {
		const [a, b] = pairedSessions();
		const laptop = device(a);
		const phone = device(b);
		a.adapter.putText("n1.md", "base 1");
		a.adapter.putText("n2.md", "base 2");
		await laptop.sync();
		await phone.sync();
		a.adapter.putText("n1.md", "base 1\nA1");
		a.adapter.putText("n2.md", "base 2\nA2");
		await laptop.sync();
		b.adapter.putText("n1.md", "B1\nbase 1");
		b.adapter.putText("n2.md", "B2\nbase 2");
		await unreachable(a, "base 2\nA2");
		await phone.auto();
		vi.restoreAllMocks();
		a.adapter.putText("n1.md", "base 1");
		await laptop.sync();
		await phone.sync();
		await laptop.sync();
		expect([a.text("n1.md"), b.text("n1.md")]).toEqual([
			"B1\nbase 1",
			"B1\nbase 1",
		]);
	});

	it("keeps the files that landed before the folder pass failed", async () => {
		const [a, b] = pairedSessions();
		const laptop = device(a);
		a.adapter.putText("n.md", "base");
		await laptop.sync();
		await b.adoptRemote();
		b.adapter.putText("n.md", "base");
		a.adapter.putText("n.md", "base\nX");
		await a.adapter.mkdir("empty");
		await laptop.sync();
		const mkdir = InMemoryAdapter.prototype.mkdir.bind(b.adapter);
		vi.spyOn(b.adapter, "mkdir").mockImplementation(async (path) => {
			if (path === "empty") throw new Error("EACCES");
			return mkdir(path);
		});
		const pulled = await pullPaths(b.deps(), await b.compare(), ["n.md"]);
		expect(pulled.failed).toMatchObject({ message: "EACCES" });
		expect(pulled.baseline.files["n.md"]?.hash).toBe(
			await sha256Hex(textToBytes("base\nX")),
		);
	});

	it("keeps the moves that landed before one that failed", async () => {
		const [a, b] = pairedSessions();
		const laptop = device(a);
		const files = { "a1.md": "one", "a2.md": "two" };
		for (const [path, text] of Object.entries(files)) {
			a.adapter.putText(path, text);
		}
		await laptop.sync();
		await b.adoptRemote();
		for (const [path, text] of Object.entries(files)) {
			b.adapter.putText(path, text);
		}
		await a.adapter.rename("a1.md", "b1.md");
		await a.adapter.rename("a2.md", "b2.md");
		await laptop.sync();
		const result = await b.compare();
		const [first, second] = result.diff.moves;
		if (!first || !second) throw new Error("expected two moves");
		const rename = InMemoryAdapter.prototype.rename.bind(b.adapter);
		vi.spyOn(b.adapter, "rename").mockImplementation(async (from, to) => {
			if (from !== second.from) return rename(from, to);
			await b.adapter.remove(from);
			throw new Error("stranded");
		});
		const pulled = await pullPaths(b.deps(), result, [
			"a1.md",
			"b1.md",
			"a2.md",
			"b2.md",
		]);
		expect(pulled.failed).toMatchObject({ message: "stranded" });
		expect([
			pulled.baseline.files[first.to] !== undefined,
			pulled.baseline.files[first.from] !== undefined,
		]).toEqual([true, false]);
	});
});
