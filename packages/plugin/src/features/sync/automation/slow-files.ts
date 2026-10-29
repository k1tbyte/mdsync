import type { App } from "obsidian";
import { DRAWING_KEY } from "@/core/drawing";

/** Nonstop editing still pushes this often. */
export const SLOW_FILE_CAP_MS = 10 * 60_000;

const DRAWING_SUFFIX = ".excalidraw.md";

/** Named by one of `suffixes` (the setting); a drawing named as a plain note counts as `.excalidraw.md`. */
export function isSlowFile(app: App, path: string, suffixes: string): boolean {
	const name = path.toLowerCase();
	const listed = suffixes
		.toLowerCase()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (listed.some((suffix) => name.endsWith(suffix))) return true;
	return (
		listed.includes(DRAWING_SUFFIX) &&
		name.endsWith(".md") &&
		DRAWING_KEY in (app.metadataCache.getCache(path)?.frontmatter ?? {})
	);
}

/** Routes a due file as any edit; false when nothing queued it. */
export type QueueEdit = (path: string) => boolean;

interface Entry {
	since: number;
	/** Null once due: it waits for the push it was queued for. */
	timer: number | null;
	/** Saved while due: the push may have read it before, so it is held again after. */
	again?: boolean;
}

/**
 * Files saved every few seconds while open (drawings, canvases), held out of automatic pushes while edited:
 * they would push on every save and keep the vault's quiet queue from ever firing. A held file is due after its
 * own quiet period, once its view is left, or {@link SLOW_FILE_CAP_MS} after its first held save.
 */
export class SlowFiles {
	private readonly entries = new Map<string, Entry>();

	holds(path: string): boolean {
		return (this.entries.get(path)?.timer ?? null) !== null;
	}

	/** A save of `path` in the active view. */
	saved(path: string, quietMs: number, queue: QueueEdit): void {
		const entry = this.entries.get(path);
		if (entry && entry.timer === null) {
			entry.again = true;
			return;
		}
		const since = entry?.since ?? Date.now();
		if (entry?.timer != null) window.clearTimeout(entry.timer);
		const wait = Math.min(quietMs, since + SLOW_FILE_CAP_MS - Date.now());
		const timer = window.setTimeout(
			() => this.release(path, queue),
			Math.max(0, wait),
		);
		this.entries.set(path, { since, timer });
	}

	/** The active view shows `open` now: every other held file was left. */
	left(open: string | null, queue: QueueEdit): void {
		for (const path of [...this.entries.keys()]) {
			if (path !== open) this.release(path, queue);
		}
	}

	/** The push queued for `paths` ended, landed or not: the next save holds again. */
	settled(paths: Iterable<string>, quietMs: number, queue: QueueEdit): void {
		for (const path of paths) {
			const entry = this.entries.get(path);
			if (!entry || entry.timer !== null) continue;
			this.entries.delete(path);
			if (entry.again) this.saved(path, quietMs, queue);
		}
	}

	/** Deleted or renamed: its own event routes it. */
	forget(path: string): void {
		const timer = this.entries.get(path)?.timer;
		if (timer != null) window.clearTimeout(timer);
		this.entries.delete(path);
	}

	clear(): void {
		for (const path of [...this.entries.keys()]) this.forget(path);
	}

	private release(path: string, queue: QueueEdit): void {
		const entry = this.entries.get(path);
		if (!entry || entry.timer === null) return;
		window.clearTimeout(entry.timer);
		entry.timer = null;
		if (!queue(path)) this.entries.delete(path);
	}
}
