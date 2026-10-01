/**
 * The file sync's side of live editing: a version marked `live` is a room
 * snapshot, never merged into its room; a note whose room is open here is never
 * written. Declared here so `sync/` never imports `live/`.
 */

import { entryAt } from "@/shared/records";

import {
	bytesToText,
	loadBaselineText,
	loadRemoteBytes,
	loadRemoteText,
	writeFetched,
} from "./content";
import type { CompareResult, EngineDependencies } from "./engine";
import type { LiveMark, ManifestEntry } from "./types";

export interface IncomingText {
	base: string;
	incoming: string;
}

/** "later": ask again next cycle, the room is not there yet. */
export type LiveTake = "taken" | "later" | "cold";

export interface LiveNotes {
	/** The room snapshot a local version with this hash is, or null for a plain edit. */
	mark(path: string, hash: string): Promise<LiveMark | "later" | null>;
	/**
	 * Offers an incoming version to the note's open room, which saves what it
	 * took to the file. `texts` resolves null for a deletion.
	 */
	absorb(
		path: string,
		mark: LiveMark | undefined,
		texts: () => Promise<IncomingText | null>,
	): Promise<LiveTake>;
	/** A snapshot written to a closed note: its next open merges against it. */
	wrote(path: string, mark: LiveMark, text: string): Promise<void>;
	/** A room has, or is opening, the note: the file sync neither moves nor writes it. */
	holds(path: string): boolean;
	/** Another device deleted a note open here: it stays, now a new file. */
	kept(path: string): void;
}

/** Which side an incoming version of a live note settles on, or null for the cold path. */
export type LiveSettle = "local" | "remote" | "later";

export async function settleLive(
	deps: EngineDependencies,
	result: CompareResult,
	path: string,
): Promise<LiveSettle | null> {
	const { live } = deps;
	if (!live) return null;
	const remote = entryAt(result.remote?.files ?? {}, path);
	let unreadable = false;
	const take = await live.absorb(path, remote?.live, async () => {
		if (!remote) return null;
		const [base, incoming] = await Promise.all([
			loadBaselineText(deps, deps.state.baseline, path),
			loadRemoteText(deps, remote.hash),
		]);
		// Missing, too large or not text: no deletion, and nothing the room could take.
		if (incoming === null) unreadable = true;
		return incoming === null ? null : { base: base ?? "", incoming };
	});
	// Read as a deletion the room left the note be; settled "local", the next push would overwrite the remote.
	if (unreadable) return "later";
	if (take === "taken") {
		if (!remote) live.kept(path);
		return "local";
	}
	if (take === "later") return "later";
	const local = entryAt(result.snapshot.files, path);
	if (!remote?.live || !local) return null;
	const mark = await live.mark(path, local.hash);
	// A room opened meanwhile: this cycle must not write under it.
	if (mark === "later") return "later";
	if (mark?.doc !== remote.live.doc) return null;
	// Two snapshots of one note: the later one holds everything the other did.
	return isNewerMark(remote.live, mark) ? "remote" : "local";
}

/** A successor room starts from its predecessor's last text, so generations order first. */
export function isNewerMark(
	a: Omit<LiveMark, "doc">,
	b: Omit<LiveMark, "doc">,
): boolean {
	return a.gen !== b.gen ? a.gen > b.gen : a.seq > b.seq;
}

/**
 * Marks the live notes among `paths` and holds back those an open room has
 * not settled on, or that would publish a snapshot older than the remote's.
 */
export async function liveMarks(
	deps: EngineDependencies,
	result: CompareResult,
	paths: ReadonlyArray<string>,
): Promise<{ paths: string[]; marks: Map<string, LiveMark> }> {
	const marks = new Map<string, LiveMark>();
	const { live } = deps;
	if (!live) return { paths: [...paths], marks };
	const ready: string[] = [];
	for (const path of paths) {
		const local = entryAt(result.snapshot.files, path);
		// A drawing converges by its scene, so its file may lag its room.
		const mark =
			local && local.scene === undefined
				? await live.mark(path, local.hash)
				: null;
		if (mark === "later") continue;
		if (mark) {
			const remote = entryAt(result.remote?.files ?? {}, path)?.live;
			if (remote?.doc === mark.doc && !isNewerMark(mark, remote)) continue;
			marks.set(path, mark);
		}
		ready.push(path);
	}
	return { paths: ready, marks };
}

/** The disk now holds a merge on top of this remote version: a room snapshot becomes the base. */
export async function grewFrom(
	deps: EngineDependencies,
	path: string,
	entry: ManifestEntry,
): Promise<void> {
	if (!entry.live || !deps.live) return;
	const text = await loadRemoteText(deps, entry.hash);
	if (text !== null) await deps.live.wrote(path, entry.live, text);
}

/** Writes a remote version; a room snapshot also becomes its note's merge base. */
export async function writeIncoming(
	deps: EngineDependencies,
	path: string,
	entry: ManifestEntry,
	/** False after the download leaves the file be, and returns null. */
	ready?: () => Promise<boolean>,
): Promise<ManifestEntry | null> {
	const bytes = await loadRemoteBytes(deps, entry.hash);
	if (!bytes) throw new Error(`Missing remote object for ${path}`);
	if (ready && !(await ready())) return null;
	const written = await writeFetched(deps.adapter, path, entry, bytes);
	// After the file: a merge base newer than the disk would read as deletions.
	if (entry.live) await deps.live?.wrote(path, entry.live, bytesToText(bytes));
	return written;
}
