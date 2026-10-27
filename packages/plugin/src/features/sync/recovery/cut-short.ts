/**
 * Finishes the engine's writes an interruption cut short (`journal.ts`), before the diff reads them as edits;
 * a download finished so gives the baseline its entry, saved before the journal drops it.
 */

import type { DataAdapter } from "obsidian";
import { sha256Hex } from "@/core/crypto";
import { sceneOfBytes } from "@/core/drawing";
import { entryAt, reportWarning } from "@/core/shared";
import { readBinary, writeBinary } from "@/core/vault";
import { bytesToText, withLocalMtime } from "../changes/content";
import type { EngineDependencies } from "../engine";
import { grewFrom } from "../live-notes";
import type { Space } from "../remote/space";
import type {
	LocalSnapshot,
	Manifest,
	ManifestEntry,
	SessionState,
} from "../types";
import type { BaseStep, Intent, WriteJournal } from "./journal";

const UNFINISHED = "An interrupted write is still being finished.";

/** What the baseline takes should recovery finish the write of `entry`; none where it holds that already. */
export function baseStep(
	deps: EngineDependencies,
	path: string,
	entry: ManifestEntry,
): BaseStep | undefined {
	const { baseline, vaultId } = deps.state;
	if (!baseline || !vaultId) return undefined;
	const from = entryAt(baseline.files, path)?.hash;
	if (from === entry.hash) return undefined;
	return { entry, from, storage: deps.storage.identity(), vaultId };
}

/** The baseline with the steps of writes finished on recovery: one of another storage or vault, or outdated, is left out. */
export function withLanded(deps: EngineDependencies): Manifest | null {
	const { baseline, vaultId } = deps.state;
	if (!baseline || !deps.journal) return baseline;
	const storage = deps.storage.identity();
	let files: Record<string, ManifestEntry> | null = null;
	for (const { path, intent } of deps.journal.pending(deps.space)) {
		const step = intent.landed && intent.base;
		if (step?.storage !== storage || step.vaultId !== vaultId) continue;
		const now = entryAt(baseline.files, path)?.hash;
		// Taken already, maybe only in memory: saved again.
		if (now !== step.from && now !== step.entry.hash) continue;
		files ??= { ...baseline.files };
		files[path] = step.entry;
	}
	return files ? { ...baseline, files } : baseline;
}

/**
 * Saves what writes finished on recovery gave the baseline, only then lets the journal drop them: dropped
 * first, a lost save would leave the old baseline, and the download would read as this device's edit.
 */
export async function settleLanded(
	deps: EngineDependencies,
	persist: (state: SessionState) => Promise<void>,
): Promise<EngineDependencies> {
	const baseline = withLanded(deps);
	const settled =
		baseline === deps.state.baseline
			? deps
			: { ...deps, state: { ...deps.state, baseline } };
	if (settled !== deps) await persist(settled.state);
	await deps.journal?.acknowledge(deps.space);
	return settled;
}

/** At load, before anything waits on the network: puts back what was cut short, the compare does the rest. */
export async function restoreCutShort(
	adapter: DataAdapter,
	journal: WriteJournal,
	partition: readonly Space[],
): Promise<void> {
	journal.adopt(partition);
	for (const space of partition) {
		for (const { path, intent } of journal.pending(space)) {
			if (intent.landed) continue;
			try {
				const bytes = await cutFrom(adapter, journal, path, intent);
				if (bytes) await writeBinary(adapter, path, bytes);
			} catch (err) {
				reportWarning(
					`Could not finish an interrupted write of "${path}".`,
					err,
				);
			}
		}
	}
}

/** What it cannot finish yet leaves the diff: unknown, never an edit. */
export async function finishCutShort(
	deps: EngineDependencies,
	snapshot: LocalSnapshot,
): Promise<void> {
	const { journal, space } = deps;
	if (!journal) return;
	for (const { path, key, intent } of journal.pending(space)) {
		let done: Finished = null;
		try {
			done = await finish(deps, journal, snapshot, path, intent);
		} catch (err) {
			reportWarning(`Could not finish an interrupted write of "${path}".`, err);
		}
		if (done === "landed" && intent.base) {
			await journal.land(intent);
		} else if (done) {
			await journal.release(key, intent);
		} else if (deps.scope.includes(path)) {
			delete snapshot.files[path];
			snapshot.skipped = [
				...snapshot.skipped.filter((file) => file.path !== path),
				{ path, reason: "unreadable", detail: UNFINISHED },
			];
		}
	}
	// Failed, what the file still lists is judged again on load.
	await journal.save().catch(() => undefined);
}

/** "gone": never touched, or edited since; null while it cannot be finished yet. */
type Finished = "landed" | "gone" | null;

async function finish(
	deps: EngineDependencies,
	journal: WriteJournal,
	snapshot: LocalSnapshot,
	path: string,
	intent: Intent,
): Promise<Finished> {
	// Finished before a restart; an edit since stays.
	if (intent.landed) return "landed";
	// The room owns an open note's text; its save ends the write.
	if (deps.live?.holds(path)) return null;
	const local = snapshot.files[path];
	// Landed, maybe before its room's merge base followed. One the scan left out is judged by its bytes.
	if (
		local
			? local.hash === intent.hash
			: await landedOn(deps.adapter, path, intent)
	) {
		// What landed, not an edit saved since the scan: that is no merge base.
		await wrote(deps, path, intent, async () => {
			const disk = await readBinary(deps.adapter, path);
			const whole = (await sha256Hex(disk)) === intent.hash;
			return whole ? disk : journal.staged(intent);
		});
		return "landed";
	}
	const bytes = await cutFrom(deps.adapter, journal, path, intent);
	if (!bytes) return "gone";
	await writeBinary(deps.adapter, path, bytes);
	await wrote(deps, path, intent, async () => bytes);
	// The scan's verdict on a file it left out (ignored, too large, a clashing name) still holds.
	const listed =
		deps.scope.includes(path) &&
		!snapshot.skipped.some((file) => file.path === path);
	if (listed) {
		snapshot.files[path] = await withLocalMtime(deps.adapter, path, {
			hash: intent.hash,
			size: bytes.length,
			kind: deps.scope.classify(path),
			scene: await sceneOfBytes(path, bytes),
		});
	}
	return "landed";
}

/** Its note's merge base, as the write's `landed` leaves it: a marked version itself, or the one a merge grew from. */
async function wrote(
	deps: EngineDependencies,
	path: string,
	intent: Intent,
	landed: () => Promise<Uint8Array | null>,
): Promise<void> {
	if (!intent.live) {
		if (intent.base) await grewFrom(deps, path, intent.base.entry);
		return;
	}
	const bytes = await landed();
	if (bytes) await deps.live?.wrote(path, intent.live, bytesToText(bytes));
}

/** The staged copy, when the file is what a write of it cut short leaves; null when never touched or edited since. */
async function cutFrom(
	adapter: DataAdapter,
	journal: WriteJournal,
	path: string,
	intent: Intent,
): Promise<Uint8Array | null> {
	const bytes = await journal.staged(intent);
	// Staged first: without the whole copy the file was never touched.
	if (!bytes) return null;
	// A prefix, or no file in a folder that stays: anything else was edited since.
	const cut =
		(await adapter.stat(path)) !== null
			? isPrefix(await readBinary(adapter, path), bytes)
			: await folderStays(adapter, path);
	return cut ? bytes : null;
}

async function landedOn(
	adapter: DataAdapter,
	path: string,
	intent: Intent,
): Promise<boolean> {
	if ((await adapter.stat(path)) === null) return false;
	return (await sha256Hex(await readBinary(adapter, path))) === intent.hash;
}

function isPrefix(head: Uint8Array, bytes: Uint8Array): boolean {
	return (
		head.length < bytes.length && head.every((byte, i) => byte === bytes[i])
	);
}

/** A gone file in a gone folder was deleted with it: writing would bring the folder back. */
async function folderStays(
	adapter: DataAdapter,
	path: string,
): Promise<boolean> {
	const slash = path.lastIndexOf("/");
	if (slash < 0) return true;
	// Mobile `exists()` is false on any error: `stat` throws, keeping the write.
	return (await adapter.stat(path.slice(0, slash)))?.type === "folder";
}
