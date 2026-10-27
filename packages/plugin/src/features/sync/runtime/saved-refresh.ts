import { diffWithin } from "../changes/diff";
import type { LocalSession, SyncControllerHost } from "../controller";
import { pathsBySpace } from "../remote/space";
import { buildEntry } from "../scope/entry";
import type { ManifestEntry } from "../types";
import type { SyncControllerRuntimeState } from "./controller-state";

const SAVED_QUIET_MS = 300;

interface SavedRefreshDeps {
	runtimeState: SyncControllerRuntimeState;
	host: Pick<SyncControllerHost, "openLocal">;
}

/**
 * Saved files patched into the last compare, so markers and counts follow an edit without a refresh. Local
 * only and display only: nothing is persisted, no operation reads the patched result without comparing
 * again, and the next full refresh reconciles whatever this skips.
 */
export class SavedRefresh {
	private readonly paths = new Set<string>();
	private timer: number | null = null;

	constructor(private readonly deps: SavedRefreshDeps) {}

	request(path: string): void {
		this.paths.add(path);
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.fire(), SAVED_QUIET_MS);
	}

	dispose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.paths.clear();
	}

	private fire(): void {
		this.timer = null;
		const paths = [...this.paths];
		this.paths.clear();
		void this.deps.runtimeState
			.enqueueQuiet(() => this.patch(paths))
			.catch(() => undefined);
	}

	private async patch(paths: readonly string[]): Promise<void> {
		const { runtimeState: state, host } = this.deps;
		for (const [space, group] of pathsBySpace(state.spaces(), paths)) {
			const prev = state.resultOf(space);
			if (space.paused || !prev) continue;
			const epoch = state.currentEpoch();
			const local = await host.openLocal?.(space, state.spaces());
			// Settings may point at another storage since: its baseline would not match this remote.
			if (!local || local.identity !== prev.storage) continue;
			const changed = new Map<string, ManifestEntry>();
			for (const path of group) {
				const was = prev.snapshot.files[path];
				if (!was) continue;
				const entry = await savedEntry(local, path);
				if (entry && (entry.hash !== was.hash || entry.scene !== was.scene)) {
					changed.set(path, entry);
				}
			}
			// A refresh or invalidation meanwhile owns the result now.
			if (
				changed.size === 0 ||
				state.currentEpoch() !== epoch ||
				state.resultOf(space) !== prev
			) {
				continue;
			}
			const files = { ...prev.snapshot.files };
			for (const [path, entry] of changed) files[path] = entry;
			const snapshot = { ...prev.snapshot, files };
			state.patchResult(space, {
				...prev,
				snapshot,
				diff: diffWithin(
					snapshot,
					prev.remote,
					local.state.baseline,
					local.scope,
				),
			});
			state.broadcast();
		}
	}
}

/** The file as it is on disk now; null for what a quick look cannot show. */
async function savedEntry(
	local: LocalSession,
	path: string,
): Promise<ManifestEntry | null> {
	try {
		if (!local.scope.includes(path)) return null;
		const stat = await local.adapter.stat(path);
		if (stat?.type !== "file" || stat.size > local.maxFileBytes) return null;
		return await buildEntry(
			local.adapter,
			path,
			stat.size,
			stat.mtime,
			local.scope.classify(path),
			undefined,
		);
	} catch {
		return null;
	}
}
