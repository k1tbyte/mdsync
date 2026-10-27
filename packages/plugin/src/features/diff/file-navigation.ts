import type { DiffResult } from "@/features/sync";

export interface FilePosition {
	index: number;
	total: number;
}

export function getOrderedPaths(diff: DiffResult | undefined): string[] {
	if (!diff) return [];
	return [
		...diff.conflicts.map((c) => c.path),
		...diff.localChanges.map((c) => c.path),
		...diff.remoteChanges.map((c) => c.path),
	];
}

export function getFilePosition(
	paths: readonly string[],
	path: string | null,
): FilePosition | null {
	const index = path === null ? -1 : paths.indexOf(path);
	return index < 0 ? null : { index, total: paths.length };
}

export function getAdjacentPath(
	paths: readonly string[],
	path: string | null,
	delta: number,
): string | null {
	if (!path) return null;
	const next = paths.indexOf(path) + delta;
	return next >= 0 && next < paths.length ? (paths[next] ?? null) : null;
}

export function getNextConflictPath(
	diff: DiffResult | undefined,
	resolvedPath: string,
): string | null {
	return diff?.conflicts.find((c) => c.path !== resolvedPath)?.path ?? null;
}
