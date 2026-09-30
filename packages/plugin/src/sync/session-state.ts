import { entryAt } from "@/shared/records";

import { diff } from "./diff";
import type { CompareResult, EngineDependencies } from "./engine";
import type { OperationOutcome } from "./operations/types";
import { type Space, spaceOf } from "./space";
import { manifestMoved } from "./space-paths";
import type {
	LocalSnapshot,
	LocalState,
	ManifestEntry,
	SessionState,
} from "./types";

export function recomputeAfterWrite(
	prevResult: CompareResult,
	freshState: SessionState,
	outcome: OperationOutcome,
	scope: EngineDependencies["scope"],
): CompareResult {
	const baseline = freshState.baseline;
	const baselineFiles = baseline?.files ?? {};
	const remoteFiles = outcome.newRemote?.files ?? {};
	const files: Record<string, ManifestEntry> = { ...prevResult.snapshot.files };
	for (const path of outcome.touchedPaths) {
		// Explicit rewrite by operation takes precedence (null = absent); untouched paths fallback to baseline/remote.
		const next = outcome.localEntries?.has(path)
			? outcome.localEntries.get(path)
			: (baselineFiles[path] ?? remoteFiles[path]);
		if (next) {
			files[path] = next;
		} else {
			delete files[path];
		}
	}
	const snapshot: LocalSnapshot = {
		...prevResult.snapshot,
		files,
	};
	const result = diff({
		local: snapshot,
		remote: outcome.newRemote,
		baseline,
		includes: (path) => scope.includesInDiff(path),
	});
	return {
		snapshot,
		remote: outcome.newRemote,
		diff: result,
		updatedCache: freshState.hashCache,
	};
}

/** Flattens persisted per-storage state into session view, for the space mounted at `root`. */
export function projectSession(
	local: LocalState,
	identity: string,
	root: string,
): SessionState {
	const slot = local.storages[identity];
	return {
		deviceId: local.deviceId,
		deviceName: local.deviceName,
		vaultId: slot?.vaultId ?? null,
		// The share's folder was moved since: the same files, at the new root.
		baseline: slot?.baseline
			? manifestMoved(slot.baseline, slot.root ?? "", root)
			: null,
		hashCache: local.hashCache,
	};
}

/**
 * Writes session back into its storage slot, leaving other storages untouched.
 * The slot's share bases stay unless `shareBases` replaces them or the vault id changes.
 */
export function mergeSessionIntoLocal(
	current: LocalState,
	session: SessionState,
	identity: string,
	space: Space,
	shareBases?: Record<string, ManifestEntry>,
): LocalState {
	const storages: LocalState["storages"] = { ...current.storages };
	const slot = current.storages[identity];
	const at = space.root === "" ? {} : { root: space.root, space: space.id };
	const vaultId = session.vaultId ?? slot?.vaultId;
	const bases =
		shareBases ?? (slot?.vaultId === vaultId ? slot?.shareBases : undefined);
	const kept =
		bases && Object.keys(bases).length > 0 ? { shareBases: bases } : {};
	if (session.vaultId !== null) {
		storages[identity] = {
			vaultId: session.vaultId,
			baseline: session.baseline,
			...at,
			...kept,
		};
	} else if (slot && session.baseline !== null) {
		// Preserve vaultId if engine returned baseline without vaultId (defensive).
		storages[identity] = {
			vaultId: slot.vaultId,
			baseline: session.baseline,
			...at,
			...kept,
		};
	} else {
		delete storages[identity];
	}
	return {
		deviceId: session.deviceId,
		deviceName: session.deviceName,
		storages,
		hashCache: session.hashCache,
	};
}

/** Whether the share owning a path holds it in its baseline on this device. */
export function sharesHold(
	local: LocalState,
	partition: readonly Space[],
): (path: string) => boolean {
	return (path) => {
		const space = spaceOf(partition, path);
		const slot = Object.values(local.storages).find(
			(each) => each.space === space.id,
		);
		if (!slot?.baseline) return false;
		const baseline = manifestMoved(slot.baseline, slot.root ?? "", space.root);
		return entryAt(baseline.files, path) !== undefined;
	};
}

/** A rename keeps content: the hashes of what moved go with it, so no scan reads it again. */
export function carryHashes(
	state: LocalState,
	from: string,
	to: string,
	folder: boolean,
): LocalState {
	const { hashCache } = state;
	const moved = folder
		? Object.entries(hashCache).filter(([path]) => path.startsWith(`${from}/`))
		: [];
	const own = entryAt(hashCache, from);
	if (own) moved.push([from, own]);
	if (moved.length === 0) return state;
	const next = { ...hashCache };
	for (const [path, entry] of moved) {
		next[`${to}${path.slice(from.length)}`] = entry;
		delete next[path];
	}
	return { ...state, hashCache: next };
}

/** Drops a share's slot, wherever it was mounted: it mounts afresh, no session needed. */
export function forgetShare(state: LocalState, id: string): LocalState {
	const storages = Object.fromEntries(
		Object.entries(state.storages).filter(([, slot]) => slot.space !== id),
	);
	return { ...state, storages };
}
