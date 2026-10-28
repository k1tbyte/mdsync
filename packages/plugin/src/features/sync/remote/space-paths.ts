/**
 * Remote blobs hold root-relative paths so participants mounting a share at different folders agree; locally
 * everything is vault paths.
 */

import type { SnapshotChanges } from "../history/types";
import type { Manifest } from "../types";

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

function rekeyManifest(manifest: Manifest, rekey: Rekey): Manifest {
	return {
		...manifest,
		files: rekeyRecord(manifest.files, rekey),
		folders: manifest.folders?.map(rekey),
	};
}

export function changesToSpace(
	changes: SnapshotChanges,
	root: string,
): SnapshotChanges {
	return root === "" ? changes : rekeyChanges(changes, stripRoot(root));
}

export function changesToVault(
	changes: SnapshotChanges,
	root: string,
): SnapshotChanges {
	return root === "" ? changes : rekeyChanges(changes, addRoot(root));
}

function rekeyChanges(changes: SnapshotChanges, rekey: Rekey): SnapshotChanges {
	const rekeyed: SnapshotChanges = {
		added: rekeyRecord(changes.added, rekey),
		modified: rekeyRecord(changes.modified, rekey),
		deleted: rekeyRecord(changes.deleted, rekey),
	};
	if (changes.deletedLast) {
		rekeyed.deletedLast = rekeyRecord(changes.deletedLast, rekey);
	}
	return rekeyed;
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
