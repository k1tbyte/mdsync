import { entryAt } from "@/shared";
import type { ScopePolicy } from "@/vault/scope";
import type { Manifest, ManifestEntry } from "./types";

/**
 * Paths another space owns are frozen in a manifest; left there they hold the blobs of a folder this space no
 * longer syncs.
 */
export function ownedFiles(
	files: Record<string, ManifestEntry>,
	scope: ScopePolicy,
): Record<string, ManifestEntry> {
	if (Object.keys(files).every((path) => scope.owns(path))) return files;
	return Object.fromEntries(
		Object.entries(files).filter(([path]) => scope.owns(path)),
	);
}

/** A baseline must not claim frozen entries the remote dropped: once the share closes they would read as deletions. */
export function forgetDroppedForeign(
	baseline: Manifest | null,
	remote: Manifest,
	scope: ScopePolicy,
): Manifest | null {
	if (!baseline) return null;
	const dropped = droppedForeign(baseline, remote, scope);
	if (dropped.length === 0) return baseline;
	const files = { ...baseline.files };
	for (const path of dropped) delete files[path];
	return { ...baseline, files };
}

/**
 * A just-shared note has no baseline there yet, so the frozen entry is its live merge base (`baseTextOf`);
 * kept until the share holds the path or the folder is this space's again.
 */
export function heldShareBases(
	kept: Readonly<Record<string, ManifestEntry>> | undefined,
	baseline: Manifest | null,
	remote: Manifest,
	scope: ScopePolicy,
	shareHolds: (path: string) => boolean,
): Record<string, ManifestEntry> {
	const bases = { ...kept };
	for (const path of baseline ? droppedForeign(baseline, remote, scope) : []) {
		const entry = baseline?.files[path];
		if (entry) bases[path] = entry;
	}
	return Object.fromEntries(
		Object.entries(bases).filter(
			([path]) => !scope.owns(path) && !shareHolds(path),
		),
	);
}

function droppedForeign(
	baseline: Manifest,
	remote: Manifest,
	scope: ScopePolicy,
): string[] {
	return Object.keys(baseline.files).filter(
		(path) => !scope.owns(path) && !entryAt(remote.files, path),
	);
}
