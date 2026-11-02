import type { EncryptionKey } from "@/core/crypto/cipher";
import type { ObjectStorage } from "@/features/storage/types";
import { MANIFEST_VERSION } from "@/features/sync/constants";
import { diffManifests } from "@/features/sync/history/changes";
import { writePin } from "@/features/sync/history/pins";
import { pushKey, sealPushRecord } from "@/features/sync/history/remote";
import type { EFileKind, Manifest } from "@/features/sync/types";
import { publishManifest } from "./manifest";

/** Each file at size 1, mtime 1, named by its hash. */
export function manifestOf(
	snapshotId: string,
	parentSnapshotId: string | null,
	files: Record<string, string>,
	createdAt = 1,
): Manifest {
	const entries: Manifest["files"] = {};
	for (const [path, hash] of Object.entries(files)) {
		entries[path] = { hash, size: 1, mtime: 1, kind: "vault" as EFileKind };
	}
	return {
		version: MANIFEST_VERSION,
		vaultId: "v",
		snapshotId,
		parentSnapshotId,
		createdAt,
		deviceId: "d",
		files: entries,
	};
}

export async function writePushRecord(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	parent: Manifest | null,
	root = "",
): Promise<void> {
	const blob = await sealPushRecord(key, root, {
		v: 1,
		vaultId: manifest.vaultId,
		id: manifest.snapshotId,
		parentId: manifest.parentSnapshotId,
		createdAt: manifest.createdAt,
		deviceId: manifest.deviceId,
		deviceName: manifest.deviceName,
		changes: diffManifests(parent, manifest),
	});
	await storage.put(
		pushKey(manifest.snapshotId),
		blob,
		"application/octet-stream",
	);
}

/** Oldest-first chain: one push record per manifest (but `skip`), the last one published as HEAD. */
export async function seedChain(
	storage: ObjectStorage,
	key: EncryptionKey,
	chain: readonly Manifest[],
	skip: readonly string[] = [],
): Promise<void> {
	for (const [index, manifest] of chain.entries()) {
		if (skip.includes(manifest.snapshotId)) continue;
		await writePushRecord(storage, key, manifest, chain[index - 1] ?? null);
	}
	const head = chain.at(-1);
	if (head) await publishManifest(storage, key, head);
}

export function pinSnapshot(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
	label?: string,
): Promise<void> {
	return writePin(storage, key, "", {
		id: manifest.snapshotId,
		manifest,
		label,
		pinnedAt: 1,
	});
}
