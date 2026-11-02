import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf, pinSnapshot } from "@tests/helpers/history";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import { REMOTE_HISTORY_LOG_KEY } from "@/features/sync/constants";
import { clearLegacyHistory } from "@/features/sync/history/legacy";
import { pinKey } from "@/features/sync/history/pins";

let key: EncryptionKey;
let otherKey: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
	otherKey = await deriveKey("other", new Uint8Array(16));
});

async function legacyPin(storage: FakeStorage, id: string): Promise<void> {
	await storage.put(
		pinKey(id),
		await encryptJson(key, manifestOf(id, null, { "a.md": "A" })),
	);
}

describe("clearLegacyHistory", () => {
	it("deletes the 1.x log and its bare-manifest pins, keeping current and undecryptable pins", async () => {
		const storage = new FakeStorage();
		await storage.put(REMOTE_HISTORY_LOG_KEY, await encryptJson(key, {}));
		await legacyPin(storage, "old1");
		await legacyPin(storage, "old2");
		await pinSnapshot(storage, key, manifestOf("new", null, { "a.md": "A" }));
		await storage.put(
			pinKey("foreign"),
			await encryptJson(otherKey, manifestOf("foreign", null, {})),
		);

		expect(await clearLegacyHistory(storage, key)).toBe(3);
		expect((await storage.list("pins/")).sort()).toEqual([
			pinKey("foreign"),
			pinKey("new"),
		]);
		expect(await storage.exists(REMOTE_HISTORY_LOG_KEY)).toBe(false);
		expect(await clearLegacyHistory(storage, key)).toBe(0);
	});

	it("deletes the log only after every 1.x pin, so a cut-short run still shows", async () => {
		const storage = new FakeStorage();
		await storage.put(REMOTE_HISTORY_LOG_KEY, await encryptJson(key, {}));
		await legacyPin(storage, "old1");
		vi.spyOn(storage, "delete").mockRejectedValueOnce(new Error("offline"));

		await expect(clearLegacyHistory(storage, key)).rejects.toThrow("offline");
		expect(await storage.exists(REMOTE_HISTORY_LOG_KEY)).toBe(true);
		expect(await clearLegacyHistory(storage, key)).toBe(2);
		expect(await storage.list("pins/")).toEqual([]);
	});

	it("deletes 1.x pins an interrupted reset left without the log", async () => {
		const storage = new FakeStorage();
		await legacyPin(storage, "old1");

		expect(await clearLegacyHistory(storage, key)).toBe(1);
		expect(await storage.list("pins/")).toEqual([]);
	});
});
