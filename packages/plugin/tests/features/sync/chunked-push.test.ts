import { FakeStorage } from "@tests/helpers/fake-storage";
import { seeded } from "@tests/helpers/seeded";
import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import { deriveChunkIds, sha256Hex } from "@/core/crypto";
import { pullPaths } from "@/features/sync/apply/pull";
import { objectKey, recipeKey } from "@/features/sync/content/keys";
import { compare, pushPaths } from "@/features/sync/engine";
import { uploadedHere } from "@/features/sync/remote/uploads";

const SIZE = 600 * 1024;
let chunkIds: CryptoKey;
beforeAll(async () => {
	chunkIds = await deriveChunkIds(new Uint8Array(32).fill(9));
});

function random(seed: number): Uint8Array {
	const next = seeded(seed);
	return new Uint8Array(SIZE).map(() => Math.floor(next() * 256));
}

async function write(session: TestSession, bytes: Uint8Array): Promise<void> {
	await session.adapter.writeBinary("big.bin", bytes.slice().buffer);
}

async function pushAll(session: TestSession): Promise<void> {
	const result = await compare(session.deps());
	await pushPaths(
		session.deps(),
		result,
		result.diff.localChanges.map((change) => change.path),
	);
	await session.adoptRemote();
}

describe("a big file pushed in chunks", () => {
	useEncryptionKey();

	it("lands as a recipe that another device pulls, and an edit uploads only its changed chunks", async () => {
		const storage = new FakeStorage();
		const source = new TestSession("device-a", storage);
		source.chunkIds = chunkIds;
		const v1 = random(1);
		await write(source, v1);
		await pushAll(source);
		const h1 = await sha256Hex(v1);
		expect(storage.map.has(recipeKey(h1))).toBe(true);
		expect(storage.map.has(objectKey(h1))).toBe(false);

		const v2 = v1.slice();
		v2.set(new Uint8Array(64).fill(1), SIZE / 2);
		await write(source, v2);
		const put = vi.spyOn(storage, "put");
		await pushAll(source);
		const chunkPuts = put.mock.calls.filter(([at]) => at.startsWith("chunks/"));
		expect(chunkPuts.length).toBeLessThanOrEqual(2);

		const target = new TestSession("device-b", storage);
		const before = await compare(target.deps());
		await pullPaths(target.deps(), before, ["big.bin"]);
		const pulled = new Uint8Array(await target.adapter.readBinary("big.bin"));
		expect(pulled).toEqual(v2);
	});

	it("leaves a root that leans on HEAD's chunks out of the upload log, so a retry stores it again", async () => {
		const storage = new FakeStorage();
		const source = new TestSession("device-a", storage);
		source.chunkIds = chunkIds;
		const v1 = random(2);
		await write(source, v1);
		await pushAll(source);

		const v2 = v1.slice();
		v2.set(new Uint8Array(64).fill(1), SIZE / 2);
		await write(source, v2);
		const fresh = random(3);
		await source.adapter.writeBinary("new.bin", fresh.slice().buffer);
		const put = storage.put.bind(storage);
		vi.spyOn(storage, "put").mockImplementation((at, body) =>
			at === REMOTE_MANIFEST_KEY
				? Promise.reject(new Error("offline"))
				: put(at, body),
		);
		await expect(pushAll(source)).rejects.toThrow("offline");

		const h2 = await sha256Hex(v2);
		expect(storage.map.has(recipeKey(h2))).toBe(true);
		expect(uploadedHere(storage, h2)).toBe(false);
		expect(uploadedHere(storage, await sha256Hex(fresh))).toBe(true);
	});
});
