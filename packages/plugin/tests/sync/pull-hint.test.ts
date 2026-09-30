import { FakeStorage } from "@tests/helpers/fake-storage";
import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { compare, pullPaths, pushPaths } from "@/sync/engine";
import { objectKey } from "@/sync/manifest";

class HintedStorage extends FakeStorage {
	readonly hints: string[][] = [];

	prepareReads(keys: string[]): void {
		this.hints.push(keys);
	}
}

async function seededPair(storage: FakeStorage) {
	const source = new TestSession("device-a", storage);
	source.adapter.write("a.md", "first");
	source.adapter.write("b.md", "first");
	source.adapter.write("c.md", "second");
	source.adapter.write("d.md", "third");
	const first = await compare(source.deps());
	await pushPaths(
		source.deps(),
		first,
		first.diff.localChanges.map((change) => change.path),
	);
	return new TestSession("device-b", storage);
}

describe("hinting a pull's reads to the storage", () => {
	useEncryptionKey();

	it("names each object once, in download order", async () => {
		const storage = new HintedStorage();
		const target = await seededPair(storage);
		const before = await compare(target.deps());
		const paths = before.diff.remoteChanges.map((change) => change.path);
		const hash = (path: string) => before.remote?.files[path]?.hash as string;

		const result = await pullPaths(target.deps(), before, paths);

		expect(storage.hints).toEqual([
			[...new Set(paths.map(hash))].map(objectKey),
		]);
		expect(storage.hints[0]).toHaveLength(3);
		expect(result.written.size).toBe(4);
		expect(target.text("b.md")).toBe("first");
	});

	it("names only the objects of the paths it pulls", async () => {
		const storage = new HintedStorage();
		const target = await seededPair(storage);
		const before = await compare(target.deps());
		const hash = before.remote?.files["d.md"]?.hash as string;

		await pullPaths(target.deps(), before, ["d.md"]);

		expect(storage.hints).toEqual([[objectKey(hash)]]);
	});

	it("pulls the same through a storage that takes no hints", async () => {
		const target = await seededPair(new FakeStorage());
		const before = await compare(target.deps());

		const result = await pullPaths(
			target.deps(),
			before,
			before.diff.remoteChanges.map((change) => change.path),
		);

		expect(result.written.size).toBe(4);
		expect(target.text("d.md")).toBe("third");
	});
});
