/**
 * A space's remote blobs hold paths relative to its root, so participants who
 * mount a share at different folders agree; locally everything is vault paths.
 */

import type { HistoryLog } from "./history/types";
import type { Manifest } from "./types";

type Rekey = (path: string) => string;

export function manifestToSpace(manifest: Manifest, root: string): Manifest {
	return root === "" ? manifest : rekeyManifest(manifest, stripRoot(root));
}

export function manifestToVault(manifest: Manifest, root: string): Manifest {
	return root === "" ? manifest : rekeyManifest(manifest, addRoot(root));
}

/** A baseline kept under `from`, for a space now mounted at `to`. */
export function manifestMoved(
	manifest: Manifest,
	from: string,
	to: string,
): Manifest {
	return from === to
		? manifest
		: manifestToVault(manifestToSpace(manifest, from), to);
}

export function historyLogToSpace(log: HistoryLog, root: string): HistoryLog {
	return root === "" ? log : rekeyLog(log, stripRoot(root));
}

export function historyLogToVault(log: HistoryLog, root: string): HistoryLog {
	return root === "" ? log : rekeyLog(log, addRoot(root));
}

function rekeyManifest(manifest: Manifest, rekey: Rekey): Manifest {
	return {
		...manifest,
		files: rekeyRecord(manifest.files, rekey),
		folders: manifest.folders?.map(rekey),
	};
}

function rekeyLog(log: HistoryLog, rekey: Rekey): HistoryLog {
	const changes: HistoryLog["changes"] = {};
	for (const [id, { added, modified, deleted }] of Object.entries(
		log.changes,
	)) {
		changes[id] = {
			added: rekeyRecord(added, rekey),
			modified: rekeyRecord(modified, rekey),
			deleted: rekeyRecord(deleted, rekey),
		};
	}
	return { ...log, changes };
}

function rekeyRecord<V>(
	record: Record<string, V>,
	rekey: Rekey,
): Record<string, V> {
	const out: Record<string, V> = {};
	for (const [path, value] of Object.entries(record)) out[rekey(path)] = value;
	return out;
}

function stripRoot(root: string): Rekey {
	return (path) => {
		if (!path.startsWith(`${root}/`)) {
			throw new Error(`"${path}" is outside the space at "${root}"`);
		}
		return path.slice(root.length + 1);
	};
}

function addRoot(root: string): Rekey {
	return (path) => `${root}/${path}`;
}
