import { FakeStorage } from "@tests/helpers/fake-storage";
import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { pullPaths } from "@/features/sync/apply/pull";
import { compare, pushPaths } from "@/features/sync/engine";
import { objectKey } from "@/features/sync/remote/manifest";

class HintedStorage extends FakeStorage {
	readonly hints: string[][] = [];

	prepareReads(keys: string[]): void {
		this.hints.push(keys);
	}
}

class SizedStorage extends FakeStorage {
	readonly sizes = new Map<string, number | undefined>();

	override get(key: string, size?: number): Promise<Uint8Array | null> {
		this.sizes.set(key, size);
		return super.get(key);
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

describe("size hint on a pull's downloads", () => {
	useEncryptionKey();

	it("passes the manifest entry's size to the storage read", async () => {
		const storage = new SizedStorage();
		const target = await seededPair(storage);
		const before = await compare(target.deps());
		const entry = before.remote?.files["d.md"];

		await pullPaths(target.deps(), before, ["d.md"]);

		expect(entry?.size).toBe(5);
		expect(storage.sizes.get(objectKey(entry?.hash as string))).toBe(5);
	});
});
