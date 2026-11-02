import { FakeStorage } from "@tests/helpers/fake-storage";
import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import { encryptJson } from "@/core/crypto/cipher";
import { pushPathsOp } from "@/features/sync/operations/push";
import {
	ConcurrentPushError,
	fetchRemoteManifest,
} from "@/features/sync/remote/manifest";
import { EChangeType } from "@/features/sync/types";

useEncryptionKey();

/** Another device's manifest lands right after ours, and the verify read still serves the old head. */
class RacingStorage extends FakeStorage {
	private race: { sibling: Uint8Array; stale: Uint8Array } | null = null;
	private stale: Uint8Array | null = null;

	arm(sibling: Uint8Array, stale: Uint8Array): void {
		this.race = { sibling, stale };
	}

	override async put(key: string, body: Uint8Array): Promise<void> {
		await super.put(key, body);
		if (key !== REMOTE_MANIFEST_KEY || !this.race) return;
		const { sibling, stale } = this.race;
		this.race = null;
		await super.put(key, sibling);
		this.stale = stale;
	}

	override get(key: string): Promise<Uint8Array | null> {
		if (key === REMOTE_MANIFEST_KEY && this.stale) {
			const stale = this.stale;
			this.stale = null;
			return Promise.resolve(stale);
		}
		return super.get(key);
	}
}

describe("a push another device overwrote while the verify read was stale", () => {
	it("is pushed again, never read back as the remote deleting it", async () => {
		const storage = new RacingStorage();
		const a = new TestSession("device-a", storage);
		a.adapter.putText("base.md", "base\n");
		await pushPathsOp(a.deps(), await a.compare(), ["base.md"], a.context());

		const head = await fetchRemoteManifest(storage, a.deps().key, "");
		const base = head?.files["base.md"];
		if (!head || !base) throw new Error("no head");
		const sibling = await encryptJson(a.deps().key, {
			...head,
			snapshotId: "sibling",
			parentSnapshotId: head.snapshotId,
			deviceId: "device-b",
			files: { ...head.files, "theirs.md": { ...base, hash: "f".repeat(64) } },
		});
		storage.arm(sibling, storage.map.get(REMOTE_MANIFEST_KEY) as Uint8Array);

		a.adapter.putText("new.md", "mine\n");
		await expect(
			pushPathsOp(a.deps(), await a.compare(), ["new.md"], a.context()),
		).rejects.toBeInstanceOf(ConcurrentPushError);

		const after = await a.compare();
		expect(after.remote?.snapshotId).toBe("sibling");
		expect(after.diff.remoteChanges).toEqual([
			expect.objectContaining({
				path: "theirs.md",
				type: EChangeType.RemoteAdd,
			}),
		]);
		expect(after.diff.localChanges).toEqual([
			expect.objectContaining({ path: "new.md", type: EChangeType.LocalAdd }),
		]);
	});
});
