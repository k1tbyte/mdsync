import { FakeStorage } from "@tests/helpers/fake-storage";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { link } from "@tests/helpers/shared-links";
import { record } from "@tests/helpers/space-records";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	decryptJson,
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import type { LinkRecord } from "@/features/links/record";
import { tradeLinks } from "@/features/links/remote";
import { syncRecords } from "@/features/spaces/remote";

vi.mock("@/core/shared/diagnostics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	reportWarning: vi.fn(),
}));

let key: EncryptionKey;
let otherKey: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
	otherKey = await deriveKey("other", new Uint8Array(16));
});

const VAULT = "vault";
const objectName = (each: LinkRecord) => `links/${each.id}.json.enc`;

async function publish(
	storage: FakeStorage,
	each: LinkRecord,
	withKey = key,
): Promise<void> {
	await storage.put(objectName(each), await encryptJson(withKey, each));
}

async function stored(
	storage: FakeStorage,
	each: LinkRecord,
): Promise<unknown> {
	const body = storage.map.get(objectName(each));
	return body ? decryptJson(key, body) : null;
}

/** Leaves its objects out of the listing, as a lagging one may. */
class Unlisted extends FakeStorage {
	override async list(): Promise<string[]> {
		return [];
	}
}

describe("tradeLinks", () => {
	it("publishes a link never traded, without what only this device knows, and binds it to the storage", async () => {
		const storage = new FakeStorage(VAULT);
		const mine = link("a");

		const traded = await tradeLinks(storage, key, [mine]);

		expect(traded).toEqual({
			links: [{ ...mine, vault: VAULT }],
			changed: true,
		});
		expect(await stored(storage, mine)).toEqual(mine);
	});

	it("writes nothing and keeps its own copies while nothing changed", async () => {
		const storage = new FakeStorage(VAULT);
		const first = await tradeLinks(storage, key, [link("a")]);
		const body = storage.map.get(objectName(link("a")));

		const second = await tradeLinks(storage, key, first.links);

		expect(second.changed).toBe(false);
		expect(second.links[0]).toBe(first.links[0]);
		expect(storage.map.get(objectName(link("a")))).toBe(body);
	});

	it("takes in the links another device traded", async () => {
		const storage = new FakeStorage(VAULT);
		const theirs = link("b", "b.md", { author: "phone" });
		await publish(storage, theirs);

		const traded = await tradeLinks(storage, key, [link("a")]);

		expect(traded.links).toEqual([
			{ ...link("a"), vault: VAULT },
			{ ...theirs, vault: VAULT },
		]);
	});

	it("lets the newer revision win either way", async () => {
		const storage = new FakeStorage(VAULT);
		await publish(storage, link("a", "remote.md", { rev: 3 }));
		await publish(storage, link("b", "remote.md", { rev: 3 }));
		const local = [
			link("a", "local.md", { rev: 2, vault: VAULT }),
			link("b", "local.md", { rev: 4, vault: VAULT }),
		];

		const traded = await tradeLinks(storage, key, local);

		expect(traded.links.map(({ path, rev }) => [path, rev])).toEqual([
			["remote.md", 3],
			["local.md", 4],
		]);
		expect(await stored(storage, link("b"))).toMatchObject({
			path: "local.md",
		});
	});

	it("drops a traded copy the storage no longer lists: removed on another device, even if edited here", async () => {
		const storage = new FakeStorage(VAULT);
		const edited = link("a", "moved.md", { rev: 5, vault: VAULT });

		const traded = await tradeLinks(storage, key, [edited]);

		expect(traded).toEqual({ links: [], changed: false });
		expect(storage.map.size).toBe(0);
	});

	it("publishes a copy last traded with another storage instead of dropping it", async () => {
		const storage = new FakeStorage(VAULT);
		const moved = link("a", "a.md", { vault: "old" });

		const traded = await tradeLinks(storage, key, [moved]);

		expect(traded.links).toEqual([{ ...moved, vault: VAULT }]);
		expect(await stored(storage, moved)).toEqual(link("a"));
	});

	it("deletes a removed link from the storage and forgets it", async () => {
		const storage = new FakeStorage(VAULT);
		await publish(storage, link("a"));

		const traded = await tradeLinks(storage, key, [
			link("a", "a.md", { vault: VAULT, removed: true }),
		]);

		expect(traded).toEqual({ links: [], changed: true });
		expect(storage.map.size).toBe(0);
	});

	it("deletes a removed link that a lagging listing leaves out", async () => {
		const storage = new Unlisted(VAULT);
		await publish(storage, link("a"));

		await tradeLinks(storage, key, [
			link("a", "a.md", { vault: VAULT, removed: true }),
		]);

		expect(storage.map.size).toBe(0);
	});

	it("fails whole when a removal does not go through, so it is tried again", async () => {
		const storage = new FakeStorage(VAULT);
		const failure = new Error("offline");
		vi.spyOn(storage, "delete").mockRejectedValueOnce(failure);

		await expect(
			tradeLinks(storage, key, [
				link("a", "a.md", { vault: VAULT, removed: true }),
			]),
		).rejects.toBe(failure);
	});

	it("never writes over or drops a link whose object it cannot read", async () => {
		const storage = new FakeStorage(VAULT);
		await publish(storage, link("a", "a.md", { rev: 9 }), otherKey);
		const body = storage.map.get(objectName(link("a")));
		const mine = link("a", "a.md", { rev: 1, vault: VAULT });

		const traded = await tradeLinks(storage, key, [mine]);

		expect(traded).toEqual({ links: [mine], changed: false });
		expect(storage.map.get(objectName(link("a")))).toBe(body);
	});

	it("deletes an unreadable object of a link removed here: removal beats any revision", async () => {
		const storage = new FakeStorage(VAULT);
		await publish(storage, link("a", "a.md", { rev: 9 }), otherKey);

		const traded = await tradeLinks(storage, key, [
			link("a", "a.md", { vault: VAULT, removed: true }),
		]);

		expect(traded).toEqual({ links: [], changed: true });
		expect(storage.map.size).toBe(0);
	});

	it("keeps its read cache apart from the space records' on one storage", async () => {
		const storage = new RevalidatingStorage(VAULT);
		await publish(storage, link("a"));
		await syncRecords(storage, key, [record("s", "S")]);
		await tradeLinks(storage, key, []);
		await syncRecords(storage, key, []);
		const reads = storage.getCalls;

		await tradeLinks(storage, key, []);
		await syncRecords(storage, key, []);

		expect(storage.getCalls).toBe(reads);
	});
});
