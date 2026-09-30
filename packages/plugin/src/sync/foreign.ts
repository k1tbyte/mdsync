import { entryAt } from "@/shared/records";
import type { ScopePolicy } from "@/vault/scope";
import type { Manifest, ManifestEntry } from "./types";

/** Paths another space owns are frozen in a manifest; left there they hold the blobs of a folder this space no longer syncs. */
export function ownedFiles(
	files: Record<string, ManifestEntry>,
	scope: ScopePolicy,
): Record<string, ManifestEntry> {
	if (Object.keys(files).every((path) => scope.owns(path))) return files;
	return Object.fromEntries(
		Object.entries(files).filter(([path]) => scope.owns(path)),
	);
}

/**
 * A baseline must not claim frozen entries the remote dropped: once the share
 * closes, the folder is this space's again and they would read as deletions.
 */
export function forgetDroppedForeign(
	baseline: Manifest | null,
	remote: Manifest,
	scope: ScopePolicy,
): Manifest | null {
	if (!baseline) return null;
	const dropped = Object.keys(baseline.files).filter(
		(path) => !scope.owns(path) && !entryAt(remote.files, path),
	);
	if (dropped.length === 0) return baseline;
	const files = { ...baseline.files };
	for (const path of dropped) delete files[path];
	return { ...baseline, files };
}
