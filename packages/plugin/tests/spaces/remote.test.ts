import { FakeStorage } from "@tests/helpers/fake-storage";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { record } from "@tests/helpers/space-records";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { reportWarning } from "@/shared";
import type { SpaceRecord } from "@/spaces/record";
import { syncRecords } from "@/spaces/remote";
import type { ConditionalRead, ListedObject } from "@/storage/types";

vi.mock("@/shared/diagnostics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	reportWarning: vi.fn(),
}));

let key: EncryptionKey;
let otherKey: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
	otherKey = await deriveKey("other", new Uint8Array(16));
});

beforeEach(() => {
	vi.mocked(reportWarning).mockClear();
});

const objectName = (id: string) => `spaces/${id}.json.enc`;
const ids = (records: SpaceRecord[]) => records.map((each) => each.id);
const requests = (storage: FakeStorage) => [
	storage.listCalls,
	storage.getCalls,
];
const warningsAbout = (name: string) =>
	vi
		.mocked(reportWarning)
		.mock.calls.filter(([message]) => message.includes(name)).length;

async function publish(
	storage: FakeStorage,
	each: SpaceRecord,
	withKey = key,
): Promise<void> {
	await storage.put(objectName(each.id), await encryptJson(withKey, each));
}

class NoValidators extends RevalidatingStorage {
	override async listDetailed(prefix: string): Promise<ListedObject[]> {
		return (await this.list(prefix)).map((name) => ({
			key: name,
			etag: null,
			modified: null,
		}));
	}
}

class CoarseValidators extends RevalidatingStorage {
	override async listDetailed(prefix: string): Promise<ListedObject[]> {
		return (await this.list(prefix)).map((name) => ({
			key: name,
			etag: "same",
			modified: null,
		}));
	}
}

class LaggingReads extends RevalidatingStorage {
	private old = new Map<string, ConditionalRead>();

	async serveOld(name: string): Promise<void> {
		this.old.set(name, await super.getIfChanged(name, null));
	}

	serveCurrent(): void {
		this.old.clear();
	}

	override getIfChanged(
		name: string,
		etag: string | null,
	): Promise<ConditionalRead> {
		const lagging = this.old.get(name);
		return lagging ? Promise.resolve(lagging) : super.getIfChanged(name, etag);
	}
}

class Vanishing extends RevalidatingStorage {
	override async listDetailed(prefix: string): Promise<ListedObject[]> {
		const listed = await super.listDetailed(prefix);
		return [
			...listed,
			{ key: objectName("gone"), etag: '"gone"', modified: null },
		];
	}
}

describe("space records over a storage that lists validators", () => {
	it("keeps the records without downloading them again while nothing changed", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, record("a", "A"));
		await publish(storage, record("b", "B"));

		const first = await syncRecords(storage, key, []);
		expect(ids(first.records)).toEqual(["a", "b"]);
		expect(requests(storage)).toEqual([1, 2]);

		const second = await syncRecords(storage, key, []);
		expect(second.records).toEqual(first.records);
		expect(requests(storage)).toEqual([2, 2]);
	});

	it("reads again only the record another device changed, and the newer one wins", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, record("a", "A", 1));
		await publish(storage, record("b", "B", 1));
		await syncRecords(storage, key, [record("a", "A", 1)]);
		expect(requests(storage)).toEqual([1, 2]);

		await publish(storage, record("a", "moved", 2, "phone"));
		const next = await syncRecords(storage, key, [record("a", "A", 1)]);

		expect(requests(storage)).toEqual([2, 3]);
		expect(next.published).toBe(false);
		expect(next.records.map((each) => [each.id, each.root, each.rev])).toEqual([
			["a", "moved", 2],
			["b", "B", 1],
		]);
	});

	it("reads a record this device published once on the next cycle, then keeps it", async () => {
		const storage = new RevalidatingStorage();

		const first = await syncRecords(storage, key, [record("a", "A")]);
		expect(first.published).toBe(true);
		expect(requests(storage)).toEqual([1, 0]);

		const second = await syncRecords(storage, key, [record("a", "A")]);
		expect(second.published).toBe(false);
		expect(requests(storage)).toEqual([2, 1]);

		await syncRecords(storage, key, [record("a", "A")]);
		expect(requests(storage)).toEqual([3, 1]);
	});

	it("does not trust a cached copy of a record it has replaced", async () => {
		const storage = new CoarseValidators();
		await publish(storage, record("a", "A", 1));
		await syncRecords(storage, key, []);

		await syncRecords(storage, key, [record("a", "B", 2)]);
		const after = await syncRecords(storage, key, []);

		expect(after.records.map((each) => each.rev)).toEqual([2]);
	});

	it("drops what left the listing", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, record("a", "A"));
		await publish(storage, record("b", "B"));
		await syncRecords(storage, key, []);

		await storage.delete(objectName("a"));
		const next = await syncRecords(storage, key, []);

		expect(ids(next.records)).toEqual(["b"]);
		expect(requests(storage)).toEqual([2, 2]);
	});

	it("skips an object that vanished between the listing and the read, and asks again", async () => {
		const storage = new Vanishing();

		const first = await syncRecords(storage, key, []);
		await syncRecords(storage, key, []);

		expect(first.records).toEqual([]);
		expect(requests(storage)).toEqual([2, 2]);
	});

	it("reads an object it cannot read again every cycle, so a bad read never hides a record", async () => {
		const storage = new RevalidatingStorage();
		await storage.put(objectName("x"), new Uint8Array([1, 2, 3]));
		await publish(storage, record("y", "Y"));

		const first = await syncRecords(storage, key, []);
		await syncRecords(storage, key, []);

		expect(ids(first.records)).toEqual(["y"]);
		expect(warningsAbout("x.json.enc")).toBe(2);
		expect(storage.getCalls).toBe(3);

		await publish(storage, record("x", "X"));
		const healed = await syncRecords(storage, key, []);
		expect(ids(healed.records)).toEqual(["x", "y"]);
	});

	it("never writes its own copy over a record it cannot read: that one may be newer", async () => {
		const storage = new RevalidatingStorage();
		const unreadable = new Uint8Array([1, 2, 3]);
		await storage.put(objectName("x"), unreadable);

		const { published } = await syncRecords(storage, key, [record("x", "X")]);

		expect(published).toBe(false);
		expect(await storage.get(objectName("x"))).toEqual(unreadable);
	});

	it("warns each cycle for a record filed under another record's name", async () => {
		const storage = new RevalidatingStorage();
		await storage.put(
			objectName("b"),
			await encryptJson(key, record("a", "A")),
		);

		const first = await syncRecords(storage, key, []);
		await syncRecords(storage, key, []);

		expect(first.records).toEqual([]);
		expect(warningsAbout("b.json.enc")).toBe(2);
	});

	it("does not pin an old read under a newer listing", async () => {
		const storage = new LaggingReads();
		await publish(storage, record("a", "A", 1));
		await syncRecords(storage, key, []);

		await storage.serveOld(objectName("a"));
		await publish(storage, record("a", "A", 2));
		const stale = await syncRecords(storage, key, []);
		expect(stale.records.map((each) => each.rev)).toEqual([1]);

		storage.serveCurrent();
		const healed = await syncRecords(storage, key, []);
		expect(healed.records.map((each) => each.rev)).toEqual([2]);
	});

	it("starts cold under another key, and again when the first returns", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, record("a", "A"));

		await syncRecords(storage, key, []);
		const other = await syncRecords(storage, otherKey, []);
		expect(other.records).toEqual([]);
		expect(storage.getCalls).toBe(2);

		const back = await syncRecords(storage, key, []);
		expect(ids(back.records)).toEqual(["a"]);
		expect(storage.getCalls).toBe(3);
	});

	it("keeps a cache per storage", async () => {
		const one = new RevalidatingStorage();
		const two = new RevalidatingStorage();
		await publish(one, record("a", "A"));
		await publish(two, record("b", "B"));

		await syncRecords(one, key, []);
		const second = await syncRecords(two, key, []);

		expect(ids(second.records)).toEqual(["b"]);
	});
});

describe("space records over a storage that cannot vouch for an object", () => {
	it("reads every record on every cycle when the listing carries no validators", async () => {
		const storage = new NoValidators();
		await publish(storage, record("a", "A"));
		await publish(storage, record("b", "B"));

		await syncRecords(storage, key, []);
		const second = await syncRecords(storage, key, []);

		expect(ids(second.records)).toEqual(["a", "b"]);
		expect(requests(storage)).toEqual([2, 4]);
	});

	it("reads every record on every cycle when it cannot list validators at all", async () => {
		const storage = new FakeStorage();
		await publish(storage, record("a", "A"));

		await syncRecords(storage, key, []);
		const second = await syncRecords(storage, key, []);

		expect(ids(second.records)).toEqual(["a"]);
		expect(requests(storage)).toEqual([2, 2]);
	});

	it("warns again each cycle for an unreadable object it cannot vouch for", async () => {
		const storage = new NoValidators();
		await storage.put(objectName("x"), new Uint8Array([1]));

		await syncRecords(storage, key, []);
		await syncRecords(storage, key, []);

		expect(warningsAbout("x.json.enc")).toBe(2);
	});
});
