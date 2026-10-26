import { type DataAdapter, Platform } from "obsidian";

import { errorMessage, hasReservedChar } from "@/shared";
import { toArrayBuffer } from "@/utils";

/**
 * Folders {@link writeBinary} already wrote into: a 20k-file pull otherwise pays 60k `exists` round trips.
 * Only its retry notices a stale yes, so only it reads this; everything else probes. Keyed per adapter.
 */
const ensuredDirs = new WeakMap<DataAdapter, Set<string>>();

/** Their default disks keep `A.md` and `a.md` as one file. */
export function caseInsensitiveDisk(): boolean {
	return (
		Platform.isWin ||
		Platform.isMacOS ||
		Platform.isIosApp ||
		Platform.isAndroidApp
	);
}

/** Windows and Android cannot create a name holding a reserved character. */
export function diskRefuses(path: string): boolean {
	return (Platform.isWin || Platform.isAndroidApp) && hasReservedChar(path);
}

export async function readBinary(
	adapter: DataAdapter,
	path: string,
): Promise<Uint8Array> {
	const buffer = await adapter.readBinary(path);
	return new Uint8Array(buffer);
}

export async function writeBinary(
	adapter: DataAdapter,
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	// Windows would put `a:b.md` in a hidden stream of `a`; Android fails with FILE_NOTCREATED.
	if (diskRefuses(path)) {
		throw new Error(
			`Cannot write "${path}": its name holds a character this system does not allow.`,
		);
	}
	const buffer = toArrayBuffer(bytes);
	const parent = parentDir(path);
	const dirs = knownDirs(adapter);
	const trustedCache = parent !== null && dirs.has(parent);
	if (parent !== null && !trustedCache) {
		await ensureDir(adapter, parent);
		dirs.add(parent);
	}
	try {
		await adapter.writeBinary(path, buffer);
	} catch (err) {
		if (parent === null || !trustedCache) throw err;
		dirs.delete(parent);
		// Only a missing folder is the cache's fault; a second attempt at any other failure would just wait twice.
		if (!(await ensureDir(adapter, parent))) throw err;
		dirs.add(parent);
		await adapter.writeBinary(path, buffer);
	}
}

export async function deletePath(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	try {
		await adapter.remove(path);
	} catch (err) {
		// Absent is the outcome asked for; anything still on disk is a real failure, as callers record a
		// deletion on return.
		if (await adapter.exists(path)) throw err;
	}
}

/** A deletion the user asked for, of work maybe only here: to the system trash, else the vault's `.trash`. */
export async function trashPath(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	try {
		if (!(await adapter.trashSystem(path))) await adapter.trashLocal(path);
	} catch (err) {
		if (await adapter.exists(path)) throw err;
	}
}

/** Whether the file is still as `seen` (absent when undefined): a write would lose a later edit. */
export async function unchangedSince(
	adapter: DataAdapter,
	path: string,
	seen: { size: number; mtime: number } | undefined,
): Promise<boolean> {
	const stat = await adapter.stat(path).catch(() => null);
	if (!seen) return stat === null;
	return (
		stat?.type === "file" &&
		stat.size === seen.size &&
		stat.mtime === seen.mtime
	);
}

/** True when the folder was missing and had to be created. */
export async function ensureDir(
	adapter: DataAdapter,
	path: string,
): Promise<boolean> {
	if (!path) return false;
	if (await adapter.exists(path)) return false;
	await mkdirDeep(adapter, path);
	return true;
}

/**
 * True when it removed the folder. Obsidian's `recursive: false` never holds: mobile always recurses, desktop
 * refuses any folder. So list first.
 */
export async function removeEmptyDir(
	adapter: DataAdapter,
	path: string,
): Promise<boolean> {
	let removed = false;
	try {
		const { files, folders } = await adapter.list(path);
		if (files.length === 0 && folders.length === 0) {
			await adapter.rmdir(path, true);
			removed = true;
		}
	} catch {
		// Already gone.
	}
	// Unconditional, even on not-empty: one wasted probe beats an entry claiming a missing folder exists.
	knownDirs(adapter).delete(path);
	return removed;
}

type Rename = (from: string, to: string) => Promise<void>;

/** Recasing steps in flight: their file moves on or back at once. */
const steps = new Set<string>();

/** Live editing follows no step: peers would rename to a name nobody chose. */
export function isRecaseStep(path: string): boolean {
	return steps.has(path);
}

/** The file sits under its step name, not where it was. */
export class StrandedRenameError extends Error {
	override readonly name = "StrandedRenameError";
}

/**
 * False when `to` is another file's. Obsidian mobile never learns its disk is case-blind and refuses a new case
 * of a name as taken, so there a recasing steps through a free name, as people do by hand.
 */
export async function renameCaseSafe(
	rename: Rename,
	exists: (path: string) => Promise<boolean>,
	from: string,
	to: string,
): Promise<boolean> {
	const recasing =
		from !== to &&
		from.toLowerCase() === to.toLowerCase() &&
		parentDir(from) === parentDir(to);
	try {
		await rename(from, to);
		return true;
	} catch (err) {
		if (!recasing) throw err;
	}
	let step = stepName(from, 0);
	for (let n = 1; await exists(step); n++) step = stepName(from, n);
	steps.add(step);
	try {
		await rename(from, step);
		let landed = false;
		try {
			// Free only now on a case-blind disk; a case-sensitive one may hold another file there.
			if (!(await exists(to))) {
				await rename(step, to);
				landed = true;
			}
		} finally {
			if (!landed) await putBack(rename, step, from);
		}
		return landed;
	} finally {
		steps.delete(step);
	}
}

async function putBack(rename: Rename, step: string, from: string) {
	await rename(step, from).catch((err: unknown) => {
		throw new StrandedRenameError(
			`"${from}" was left as "${step}": rename it back. ${errorMessage(err)}`,
		);
	});
}

/** Keeps the extension, so a view showing the file stays open. */
function stepName(path: string, n: number): string {
	const dot = path.lastIndexOf(".");
	const end = dot > path.lastIndexOf("/") + 1 ? dot : path.length;
	return `${path.slice(0, end)}.mdsync-recase${n || ""}${path.slice(end)}`;
}

export async function ensureParent(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	const parent = parentDir(path);
	if (parent !== null) await ensureDir(adapter, parent);
}

/**
 * Obsidian's desktop `mkdir` creates intermediate folders; the walk is the fallback for an adapter whose
 * mkdir does not.
 */
async function mkdirDeep(adapter: DataAdapter, path: string): Promise<void> {
	try {
		await adapter.mkdir(path);
		return;
	} catch {
		// Fall through to the walk, which reports the real failure if there is one.
	}
	let cursor = "";
	for (const segment of path.split("/")) {
		if (!segment) continue;
		cursor = cursor ? `${cursor}/${segment}` : segment;
		if (await adapter.exists(cursor)) continue;
		await adapter.mkdir(cursor);
	}
}

function knownDirs(adapter: DataAdapter): Set<string> {
	let dirs = ensuredDirs.get(adapter);
	if (!dirs) {
		dirs = new Set();
		ensuredDirs.set(adapter, dirs);
	}
	return dirs;
}

/** Null for a vault-root path, which needs no folder. */
function parentDir(path: string): string | null {
	const slash = path.lastIndexOf("/");
	return slash > 0 ? path.slice(0, slash) : null;
}
