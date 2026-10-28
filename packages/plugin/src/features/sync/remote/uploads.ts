import type { ListedObject, ObjectStorage } from "@/features/storage";

/**
 * Blobs uploaded here but not yet in a published manifest, so an unpublished push resumes. Any other non-head
 * blob may be swept between probe and publish, so it is re-uploaded.
 */
export const UPLOAD_TRUST_MS = 12 * 60 * 60 * 1000;

const uploads = new WeakMap<ObjectStorage, Map<string, number>>();

export function rememberUpload(storage: ObjectStorage, hash: string): void {
	let byHash = uploads.get(storage);
	if (!byHash) {
		byHash = new Map();
		uploads.set(storage, byHash);
	}
	byHash.set(hash, Date.now());
}

/** Still worth a probe; the probe decides. */
export function uploadedHere(storage: ObjectStorage, hash: string): boolean {
	const at = uploads.get(storage)?.get(hash);
	return at !== undefined && Date.now() - at < UPLOAD_TRUST_MS;
}

/** Published blobs are the head's and its history's to keep, not ours. */
export function forgetUploads(
	storage: ObjectStorage,
	hashes: Iterable<string>,
): void {
	const byHash = uploads.get(storage);
	if (!byHash || byHash.size === 0) return;
	for (const hash of hashes) byHash.delete(hash);
}

/** Past any upload a push still trusts, with room for clock skew. */
export const SETTLED_AFTER_MS = 2 * UPLOAD_TRUST_MS;

/**
 * Every object under `prefix`, dated: another device's push uploads before it publishes, and a pin's manifest
 * lands before its flag, so only one older than {@link SETTLED_AFTER_MS} may be no push's. Undated ones are kept.
 */
export async function listDated(
	storage: ObjectStorage,
	prefix: string,
): Promise<ListedObject[]> {
	if (!storage.listDetailed) {
		throw new Error(
			"This storage does not report when objects were written, so a running upload cannot be told from an orphan.",
		);
	}
	return storage.listDetailed(prefix);
}
