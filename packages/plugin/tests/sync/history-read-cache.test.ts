import { FakeStorage } from "@tests/helpers/fake-storage";
import { publishManifest } from "@tests/helpers/manifest";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { getFileHistory } from "@/sync/history/query";
import { pinKey, readHistoryLog, writeHistoryLog } from "@/sync/history/store";
import type { HistoryLog } from "@/sync/history/types";
import type { EFileKind, Manifest } from "@/sync/types";

let key: EncryptionKey;
let otherKey: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
	otherKey = await deriveKey("pw", new Uint8Array(16));
});

function logWith(...ids: string[]): HistoryLog {
	return {
		version: 2,
		snapshots: ids.map((id) => ({
			id,
			parentId: null,
			createdAt: 1,
			deviceId: "d",
			deviceName: "D",
		})),
		changes: {},
	};
}

describe("readHistoryLog validator cache", () => {
	it("reuses the cached log on 304", async () => {
		const storage = new RevalidatingStorage();
		await writeHistoryLog(storage, key, "", logWith("s1"));
		const first = await readHistoryLog(storage, key, "");
		const second = await readHistoryLog(storage, key, "");
		expect(second).toBe(first);
		expect(storage.bodiesSent).toBe(1);
	});

	it("refetches under another key", async () => {
		const storage = new RevalidatingStorage();
		await writeHistoryLog(storage, key, "", logWith("s1"));
		await readHistoryLog(storage, key, "");
		await readHistoryLog(storage, otherKey, "");
		expect(storage.bodiesSent).toBe(2);
	});

	it("drops the entry on write", async () => {
		const storage = new RevalidatingStorage();
		await writeHistoryLog(storage, key, "", logWith("s1"));
		await readHistoryLog(storage, key, "");
		await writeHistoryLog(storage, key, "", logWith("s2", "s1"));
		const log = await readHistoryLog(storage, key, "");
		expect(log.snapshots.map((s) => s.id)).toEqual(["s2", "s1"]);
		expect(storage.bodiesSent).toBe(2);
	});
});

describe("pin manifest cache", () => {
	it("downloads a pinned manifest once across queries", async () => {
		const storage = new FakeStorage();
		const head: Manifest = {
			version: 1,
			vaultId: "v",
			snapshotId: "h",
			parentSnapshotId: null,
			createdAt: 2,
			deviceId: "d",
			deviceName: "D",
			files: {},
		};
		await publishManifest(storage, key, head);
		const log = logWith("h", "p");
		const pin = log.snapshots[1];
		if (pin) pin.pinned = true;
		await writeHistoryLog(storage, key, "", log);
		const pinned: Manifest = {
			...head,
			snapshotId: "p",
			files: {
				"a.md": { hash: "A", size: 1, mtime: 1, kind: "vault" as EFileKind },
			},
		};
		storage.map.set(pinKey("p"), await encryptJson(key, pinned));
		const pinGets = () => storage.getCalls;

		const query = { storage, key, root: "", path: "a.md" };
		const first = await getFileHistory(query);
		const before = pinGets();
		const second = await getFileHistory(query);
		expect(first.map((v) => v.snapshotId)).toEqual(["p"]);
		expect(second).toEqual(first);
		// Manifest and log are re-read; the pin is not.
		expect(pinGets() - before).toBe(2);
	});
});
