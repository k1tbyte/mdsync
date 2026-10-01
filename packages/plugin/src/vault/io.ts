import type { DataAdapter } from "obsidian";

import { toArrayBuffer } from "@/utils";

/**
 * Folders {@link writeBinary} already wrote into: a 20k-file pull otherwise pays 60k `exists` round trips.
 * Only its retry notices a stale yes, so only it reads this; everything else probes. Keyed per adapter.
 */
const ensuredDirs = new WeakMap<DataAdapter, Set<string>>();

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

export async function removeEmptyDir(
	adapter: DataAdapter,
	path: string,
): Promise<void> {
	try {
		await adapter.rmdir(path, false);
	} catch {
		// Ignore if not empty or already gone.
	}
	// Unconditional, even on not-empty: one wasted probe beats an entry claiming a missing folder exists.
	knownDirs(adapter).delete(path);
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
