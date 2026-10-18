import { caseInsensitiveDisk, diskRefuses } from "@/vault/io";
import type { ScopePolicy } from "@/vault/scope";
import type { LocalSnapshot, Manifest, SkippedFile } from "./types";

/** Remote paths this disk cannot hold, skipped so nothing pulls them or deletes them. */
export function skipUnholdableNames(
	snapshot: LocalSnapshot,
	remote: Manifest | null,
	baseline: Manifest | null,
	scope: ScopePolicy,
): LocalSnapshot {
	const kept = caseInsensitiveDisk()
		? skipRemoteCaseClashes(snapshot, remote, baseline)
		: snapshot;
	return skipReservedNames(kept, remote, scope);
}

/**
 * Two remote spellings of one path would land in one file on a case-insensitive disk. The one here (else
 * the baseline's, else the first) syncs; the others are skipped.
 */
function skipRemoteCaseClashes(
	snapshot: LocalSnapshot,
	remote: Manifest | null,
	baseline: Manifest | null,
): LocalSnapshot {
	if (!remote) return snapshot;
	const spellings = new Map<string, string[]>();
	for (const path of Object.keys(remote.files)) {
		const key = path.toLowerCase();
		const group = spellings.get(key);
		if (group) group.push(path);
		else spellings.set(key, [path]);
	}
	const known = new Set(snapshot.skipped.map(({ path }) => path));
	const clashes: SkippedFile[] = [];
	for (const group of spellings.values()) {
		if (group.length < 2) continue;
		const kept =
			group.find((path) => path in snapshot.files) ??
			group.find((path) => baseline?.files[path] !== undefined) ??
			(group.sort()[0] as string);
		for (const path of group) {
			if (path === kept || known.has(path)) continue;
			clashes.push({ path, reason: "case-clash", other: kept });
		}
	}
	return withSkipped(snapshot, clashes);
}

/** Its write would fail and stop the whole pull. */
function skipReservedNames(
	snapshot: LocalSnapshot,
	remote: Manifest | null,
	scope: ScopePolicy,
): LocalSnapshot {
	if (!remote) return snapshot;
	const known = new Set(snapshot.skipped.map(({ path }) => path));
	const refused: SkippedFile[] = [];
	for (const path of Object.keys(remote.files)) {
		if (!diskRefuses(path) || known.has(path) || !scope.includes(path)) {
			continue;
		}
		refused.push({ path, reason: "reserved-name" });
	}
	return withSkipped(snapshot, refused);
}

function withSkipped(
	snapshot: LocalSnapshot,
	more: SkippedFile[],
): LocalSnapshot {
	return more.length === 0
		? snapshot
		: { ...snapshot, skipped: [...snapshot.skipped, ...more] };
}
