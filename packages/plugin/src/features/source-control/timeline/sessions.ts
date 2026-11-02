import {
	composeChanges,
	keepSize,
	type Resolution,
	type SnapshotChanges,
	type SnapshotSummary,
} from "@/features/sync";
import { ageLabel } from "../history/age-groups";

/** Pushes further apart than this, or than one kept period, start a new sitting. */
const SESSION_GAP_MS = 10 * 60_000;

export interface Session {
	/** Newest first, as the walk lists them. */
	versions: SnapshotSummary[];
	at: number;
	firstAt: number;
	res: Resolution | null;
	pinned: boolean;
	pushes: number;
	/** From the oldest version's parent to the newest version; null when a version has no record. */
	changes: SnapshotChanges | null;
}

/**
 * Splits the walk into sittings: consecutive versions of one device and resolution under one heading, each
 * close to the next. A pin stands alone, so a session never skips a link of the chain it composes.
 */
export function sessionsOf(
	versions: readonly SnapshotSummary[],
	now: number = Date.now(),
): Session[] {
	const runs: SnapshotSummary[][] = [];
	for (const version of listed(versions)) {
		const run = runs[runs.length - 1];
		const newer = run?.[run.length - 1];
		if (run && newer && continues(newer, version, now)) run.push(version);
		else runs.push([version]);
	}
	return runs.map(sessionOf);
}

/** A version that changed only what history leaves out (the configuration folder) is not listed. */
function listed(versions: readonly SnapshotSummary[]): SnapshotSummary[] {
	const shown = versions.filter(
		({ pinned, files }) =>
			pinned ||
			!files ||
			Object.keys({ ...files.added, ...files.modified, ...files.deleted })
				.length > 0,
	);
	// Everything above the newest shown version changed no vault file, so it still holds what HEAD does; an
	// off-walk pin (no files) is another state.
	const [newest] = shown;
	if (newest?.files && newest !== versions[0] && versions[0]?.isHead)
		shown[0] = { ...newest, isHead: true };
	return shown;
}

function continues(
	newer: SnapshotSummary,
	older: SnapshotSummary,
	now: number,
): boolean {
	if (newer.pinned || older.pinned) return false;
	if (newer.deviceId !== older.deviceId || newer.res !== older.res)
		return false;
	const gap = Math.max(SESSION_GAP_MS, (older.res && keepSize(older.res)) ?? 0);
	return (
		newer.firstAt - older.at < gap &&
		ageLabel(newer, now) === ageLabel(older, now)
	);
}

function sessionOf(versions: SnapshotSummary[]): Session {
	const newest = versions[0] as SnapshotSummary;
	const oldest = versions[versions.length - 1] as SnapshotSummary;
	return {
		versions,
		at: newest.at,
		firstAt: oldest.firstAt,
		res: newest.res,
		pinned: newest.pinned,
		pushes: versions.reduce((sum, version) => sum + version.pushes, 0),
		changes: composed(versions),
	};
}

function composed(
	versions: readonly SnapshotSummary[],
): SnapshotChanges | null {
	if (versions.length === 1) return versions[0]?.files ?? null;
	const run: SnapshotChanges[] = [];
	for (const version of [...versions].reverse()) {
		if (!version.files) return null;
		run.push(version.files);
	}
	return composeChanges(run);
}
