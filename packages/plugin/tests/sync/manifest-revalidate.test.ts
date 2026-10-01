import { FakeStorage } from "@tests/helpers/fake-storage";
import { RevalidatingStorage } from "@tests/helpers/revalidating-storage";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { advanceBaselineForPaths } from "@/sync/baseline";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import {
	ConcurrentPushError,
	fetchRemoteManifest,
	publishManifestWithGuard,
} from "@/sync/manifest";
import { EFileKind, type Manifest } from "@/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function manifest(snapshotId: string): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: null,
		createdAt: 0,
		deviceId: "device-a",
		files: {},
	};
}

async function publish(storage: FakeStorage, head: Manifest): Promise<void> {
	await storage.put(REMOTE_MANIFEST_KEY, await encryptJson(key, head));
}

describe("fetchRemoteManifest revalidation", () => {
	it("returns the complete cache even when the device only adopted one path", async () => {
		const storage = new RevalidatingStorage();
		const entry = { hash: "content", size: 7, mtime: 0, kind: EFileKind.Vault };
		await publish(storage, {
			...manifest("s1"),
			files: { "accepted.md": entry, "pending.md": entry },
			folders: ["Remote only"],
		});
		const remote = (await fetchRemoteManifest(storage, key, "")) as Manifest;
		const baseline = advanceBaselineForPaths(
			null,
			remote,
			new Set(["accepted.md"]),
			[],
		);
		expect(baseline.files["pending.md"]).toBeUndefined();
		const refreshed = await fetchRemoteManifest(storage, key, "");
		expect(refreshed).toBe(remote);
		expect(refreshed?.folders).toEqual(["Remote only"]);
		expect(storage.bodiesSent).toBe(1);
	});

	it("revalidates repeated reads without any baseline", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		const first = await fetchRemoteManifest(storage, key, "");
		expect(await fetchRemoteManifest(storage, key, "")).toBe(first);
		expect(await fetchRemoteManifest(storage, key, "")).toBe(first);
		expect(storage.bodiesSent).toBe(1);
	});

	it("does not reuse a validator under a different key", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, "");
		const otherKey = await deriveKey("other", new Uint8Array(16));
		await expect(fetchRemoteManifest(storage, otherKey, "")).rejects.toThrow();
		expect(storage.bodiesSent).toBe(2);
	});

	it("does not reuse projected paths under a different root", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, {
			...manifest("s1"),
			files: {
				"note.md": { hash: "h", size: 1, mtime: 0, kind: EFileKind.Vault },
			},
		});
		await fetchRemoteManifest(storage, key, "Old");
		const moved = await fetchRemoteManifest(storage, key, "New");
		expect(Object.keys(moved?.files ?? {})).toEqual(["New/note.md"]);
		expect(storage.bodiesSent).toBe(2);
	});

	it("never shares validators between storage adapters", async () => {
		const a = new RevalidatingStorage();
		const b = new RevalidatingStorage();
		await publish(a, manifest("a"));
		await publish(b, manifest("b"));
		await fetchRemoteManifest(a, key, "");
		expect((await fetchRemoteManifest(b, key, ""))?.snapshotId).toBe("b");
		expect(b.bodiesSent).toBe(1);
	});

	it("downloads the manifest another device published", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, "");
		await publish(storage, manifest("s2"));
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s2",
		);
		expect(storage.bodiesSent).toBe(2);
	});

	it("forgets the validator when the manifest is gone", async () => {
		const storage = new RevalidatingStorage();
		await publish(storage, manifest("s1"));
		await fetchRemoteManifest(storage, key, "");
		await storage.delete(REMOTE_MANIFEST_KEY);
		expect(await fetchRemoteManifest(storage, key, "")).toBeNull();
		await publish(storage, manifest("s3"));
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s3",
		);
	});

	it("refuses not-modified when no validator was sent", async () => {
		const storage = new RevalidatingStorage();
		storage.getIfChanged = async () => ({ status: "unchanged" });
		await expect(fetchRemoteManifest(storage, key, "")).rejects.toThrow(
			"not modified",
		);
	});

	it("reads unconditionally from a backend with no validator", async () => {
		const storage = new FakeStorage();
		await publish(storage, manifest("s1"));
		const first = await fetchRemoteManifest(storage, key, "");
		const again = await fetchRemoteManifest(storage, key, "");
		expect(again).toEqual(first);
		expect(again).not.toBe(first);
	});
});

describe("the push guard over a revalidated precheck", () => {
	it("keeps both publish guards even with a complete cached head", async () => {
		const storage = new RevalidatingStorage();
		const baseline = manifest("s1");
		await publish(storage, baseline);
		await fetchRemoteManifest(storage, key, "");
		const next = { ...manifest("s2"), parentSnapshotId: "s1" };
		await publishManifestWithGuard(storage, key, "", next, "s1", baseline);
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s2",
		);
		expect(storage.bodiesSent).toBe(2);
	});

	it("still catches a writer that got there first", async () => {
		const storage = new RevalidatingStorage();
		const baseline = manifest("s1");
		await publish(storage, baseline);
		await fetchRemoteManifest(storage, key, "");
		await publish(storage, manifest("other"));
		const next = { ...manifest("s2"), parentSnapshotId: "s1" };
		await expect(
			publishManifestWithGuard(storage, key, "", next, "s1", baseline),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});
});
