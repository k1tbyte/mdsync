import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomId,
} from "@/core/crypto";
import type { ConditionalRead, ObjectStorage } from "@/features/storage";
import { MANIFEST_VERSION } from "../constants";
import { defaultDeviceName } from "../identity/device";
import type { LocalSnapshot, Manifest } from "../types";
import { manifestToSpace, manifestToVault } from "./space-paths";

// A per-path baseline can share a snapshot id with HEAD without holding all its files.
const validators = new WeakMap<
	ObjectStorage,
	{ etag: string; manifest: Manifest; key: EncryptionKey; root: string }
>();
const publishedHeads = new WeakMap<
	ObjectStorage,
	{ manifest: Manifest; key: EncryptionKey }
>();

export async function fetchRemoteManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<Manifest | null> {
	const cached = validators.get(storage);
	const validator =
		cached?.key === key && cached.root === root ? cached : undefined;
	const read = await readIfChanged(
		storage,
		REMOTE_MANIFEST_KEY,
		validator?.etag ?? null,
	);
	if (read.status === "unchanged") {
		// Only an answer about the validator we sent; for an unconditional read it describes nothing we hold
		// and would look like a never-pushed vault.
		if (!validator) {
			throw new Error(
				"Storage answered 'not modified' to a read that carried no validator.",
			);
		}
		return validator.manifest;
	}
	if (read.status === "absent") {
		validators.delete(storage);
		publishedHeads.delete(storage);
		return null;
	}
	const raw = await decryptJson<Manifest>(key, read.body);
	if (raw.version > MANIFEST_VERSION) {
		throw new Error(
			`Remote manifest version ${raw.version} requires a newer MDSync version.`,
		);
	}
	const manifest = manifestToVault(raw, root);
	if (read.etag) {
		validators.set(storage, {
			etag: read.etag,
			manifest,
			key,
			root,
		});
	} else {
		validators.delete(storage);
	}
	return manifest;
}

/** A conditional read where the backend has validators, else a plain one. */
export function readIfChanged(
	storage: ObjectStorage,
	name: string,
	etag: string | null,
): Promise<ConditionalRead> {
	if (storage.getIfChanged) return storage.getIfChanged(name, etag);
	return storage
		.get(name)
		.then((body) =>
			body ? { status: "found", body, etag: null } : { status: "absent" },
		);
}

// Only a complete head actually published by this session can replace a stale read.
export function reconcileRemoteAgainstBaseline(
	remote: Manifest | null,
	baseline: Manifest | null,
	storage?: ObjectStorage,
	key?: EncryptionKey,
): Manifest | null {
	if (!remote || !baseline) return remote;
	if (remote.snapshotId === baseline.snapshotId) return remote;
	const published = storage ? publishedHeads.get(storage) : undefined;
	if (
		published?.key === key &&
		published?.manifest.snapshotId === baseline.snapshotId &&
		published.manifest.parentSnapshotId === remote.snapshotId
	) {
		return published.manifest;
	}
	if (
		baseline.parentSnapshotId &&
		remote.snapshotId === baseline.parentSnapshotId
	) {
		throw new Error(
			"Storage returned an older manifest. Refresh again before syncing.",
		);
	}
	return remote;
}

export class ConcurrentPushError extends Error {
	override readonly name = "ConcurrentPushError";
}

const VERIFY_DELAYS_MS = [500, 1_000, 2_000];

/**
 * Publishes if the remote head matches expectedParentSnapshotId; the post-publish verify guards races where
 * two writers pass the precheck.
 */
export async function publishManifestWithGuard(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	manifest: Manifest,
	expectedParentSnapshotId: string | null,
	baseline: Manifest | null = null,
): Promise<void> {
	// Sealed first: ~50 ms of gzip after the precheck would widen the competing-writer window.
	const blob = await encryptJson(key, manifestToSpace(manifest, root));
	// Stale-read reconciliation prevents a lagging backend from appearing as a competing writer.
	const fetched = await fetchRemoteManifest(storage, key, root);
	const precheck = reconcileRemoteAgainstBaseline(
		fetched,
		baseline,
		storage,
		key,
	);
	const precheckId = precheck?.snapshotId ?? null;
	if (precheckId !== expectedParentSnapshotId) {
		throw new ConcurrentPushError(
			"Remote manifest changed since the last compare. Re-sync and try again.",
		);
	}
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
	// Only our own id read back proves the push landed.
	const replaced = ownSnapshotIds(manifest, storage, key);
	let verify = await fetchRemoteManifest(storage, key, root);
	for (const ms of VERIFY_DELAYS_MS) {
		if (!verify || !replaced.has(verify.snapshotId)) break;
		await new Promise((resolve) => window.setTimeout(resolve, ms));
		verify = await fetchRemoteManifest(storage, key, root);
	}
	if (verify?.snapshotId === manifest.snapshotId) {
		publishedHeads.set(storage, { manifest, key });
		return;
	}
	throw new ConcurrentPushError(
		verify && replaced.has(verify.snapshotId)
			? "The storage did not show this push yet. Re-sync to see where things stand."
			: "Another device overwrote the manifest immediately after our push.",
	);
}

/** Heads this push replaced: read back, they are a stale read or a lost push, so the verify reads again. */
function ownSnapshotIds(
	published: Manifest,
	storage: ObjectStorage,
	key: EncryptionKey,
): Set<string> {
	const ids = new Set<string>();
	if (published.parentSnapshotId) ids.add(published.parentSnapshotId);
	const previous = publishedHeads.get(storage);
	if (previous?.key === key) {
		ids.add(previous.manifest.snapshotId);
		if (previous.manifest.parentSnapshotId)
			ids.add(previous.manifest.parentSnapshotId);
	}
	return ids;
}

export function buildManifest(
	deviceId: string,
	deviceName: string | undefined,
	vaultId: string,
	parent: Manifest | null,
	snapshot: Pick<LocalSnapshot, "files" | "emptyFolders">,
): Manifest {
	return {
		version: MANIFEST_VERSION,
		vaultId,
		snapshotId: randomId(),
		parentSnapshotId: parent?.snapshotId ?? null,
		createdAt: Date.now(),
		deviceId,
		deviceName: deviceName?.trim() || defaultDeviceName(),
		files: snapshot.files,
		resetGenerations: parent?.resetGenerations,
		authors: parent?.authors,
		folders:
			snapshot.emptyFolders.length > 0 ? snapshot.emptyFolders : undefined,
	};
}
