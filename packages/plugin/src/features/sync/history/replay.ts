import type { Manifest } from "../types";
import { undoChanges } from "./changes";
import type { Cover } from "./model/cover";

/**
 * Null when the walk does not start at HEAD or never reaches the target: a partial replay would invent a state.
 * Empty folders are not tracked per snapshot, so the result carries none.
 */
export function replayTo(
	head: Manifest,
	cover: Cover,
	snapshotId: string,
): Manifest | null {
	if (
		cover.lagging ||
		!cover.chain.some(({ record }) => record.id === snapshotId)
	)
		return null;
	const files = { ...head.files };
	for (const { record } of cover.chain) {
		if (record.id === snapshotId) {
			return {
				version: head.version,
				vaultId: head.vaultId,
				snapshotId: record.id,
				parentSnapshotId: record.parentId,
				createdAt: record.createdAt,
				deviceId: record.deviceId,
				deviceName: record.deviceName,
				files,
			};
		}
		undoChanges(files, record.changes);
	}
	return null;
}
