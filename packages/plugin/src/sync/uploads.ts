import type { ObjectStorage } from "@/storage/types";

/**
 * Blobs this device uploaded that no published manifest names yet, so a push
 * that never published resumes instead of starting over. Any other blob outside
 * the head may be swept by history GC or deep clean between a probe and the
 * publish, so a push uploads it again rather than trusting that it is there.
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
