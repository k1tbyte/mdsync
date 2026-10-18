export {
	changeEntries,
	contiguousLength,
	diffManifests,
	undoChanges,
	undoChangesForPath,
} from "./changes";
export {
	clampMaxSnapshots,
	gcExcessBuffer,
	shouldRunGc,
} from "./gc";
export { publishManifestWithHistory } from "./publish";
export {
	getFileHistory,
	listDeletedFiles,
	listSnapshots,
	loadVersionBytes,
} from "./query";
export { replayTo } from "./replay";
export {
	planVaultRestore,
	sameRestorePlan,
	type VaultRestorePlan,
} from "./restore-vault";
export {
	pinKey,
	readHistoryLog,
	readPinManifest,
	resolveSnapshotManifest,
	setSnapshotPinned,
} from "./store";
export type {
	DeletedFile,
	DeletedFilesResult,
	FileVersion,
	HistoryConfig,
	HistoryLog,
	SnapshotChanges,
	SnapshotEntry,
	SnapshotListResult,
	SnapshotSummary,
} from "./types";
