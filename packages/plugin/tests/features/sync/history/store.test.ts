import { FakeStorage } from "@tests/helpers/fake-storage";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import { REMOTE_HISTORY_LOG_KEY } from "@/features/sync/constants";
import { readHistoryLog } from "@/features/sync/history/store";

let key: EncryptionKey;
let otherKey: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
	otherKey = await deriveKey("pw", new Uint8Array(16));
});

const log = {
	version: 2,
	snapshots: [{ id: "s1", parentId: null, createdAt: 1, deviceId: "d" }],
	changes: {},
};

describe("readHistoryLog", () => {
	it("refuses a newer client's log", async () => {
		const storage = new FakeStorage();
		const newer = { version: 3, snapshots: [], changes: {} };
		await storage.put(REMOTE_HISTORY_LOG_KEY, await encryptJson(key, newer));

		await expect(readHistoryLog(storage, key, "")).rejects.toThrow(/newer/);
	});

	it("refuses a log that reads as missing but is there", async () => {
		const storage = new FakeStorage();
		await storage.put(REMOTE_HISTORY_LOG_KEY, await encryptJson(key, log));
		vi.spyOn(storage, "get").mockResolvedValueOnce(null);

		await expect(readHistoryLog(storage, key, "")).rejects.toThrow(/refusing/);
	});

	it("reads a log that is not there as empty", async () => {
		expect(
			(await readHistoryLog(new FakeStorage(), key, "")).snapshots,
		).toEqual([]);
	});

	it("reuses the cached log on 304, refetches under another key", async () => {
		const storage = new RevalidatingStorage();
		await storage.put(REMOTE_HISTORY_LOG_KEY, await encryptJson(key, log));
		const first = await readHistoryLog(storage, key, "");
		expect(await readHistoryLog(storage, key, "")).toBe(first);
		expect(storage.bodiesSent).toBe(1);

		await readHistoryLog(storage, otherKey, "");
		expect(storage.bodiesSent).toBe(2);
	});
});
