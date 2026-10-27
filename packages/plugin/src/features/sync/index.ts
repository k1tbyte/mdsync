export { registerScheduler } from "./automation/scheduler";
export {
	bytesToText,
	clearRemoteTextCache,
	textToBytes,
} from "./changes/content";
export { movesByPath } from "./changes/moves";
export { HUNK_TEXT_MAX_BYTES } from "./constants";
export {
	EConflictStrategy,
	SyncController,
	type SyncOperationResult,
	type SyncStatusSnapshot,
	splitSpaceErrors,
} from "./controller";
export type { CompareResult, EngineDependencies } from "./engine";
export { clampMaxSnapshots } from "./history/gc";
export type { VaultRestorePlan } from "./history/restore-vault";
export type {
	DeletedFile,
	DeletedFilesResult,
	FileVersion,
	SnapshotChanges,
	SnapshotListResult,
	SnapshotSummary,
} from "./history/types";
export {
	computeHunks,
	DIFF_BUDGET,
	type HunkSegment,
	type HunkSelection,
	hunkSegments,
	type LineRange,
	type SyncHunk,
} from "./hunks/hunks";
export {
	applyPlan,
	buildMergeSession,
	countUnresolved,
	type EditPlan,
	type EMergeSide,
	type ESideStatus,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	patchTaken,
	revertPlan,
	type Span,
	type StatusPatch,
	sameLines,
	sameStatus,
	snapToLines,
	type Taken,
	type TakenPatch,
	threeWayRegions,
	toLines,
} from "./hunks/merge-model";
export {
	EDiffDirection,
	type FileDiffModel,
	type HistoryDiffRequest,
	type HistoryVersionRef,
} from "./hunks/projection";
export { defaultDeviceName, deviceLabel } from "./identity/device";
export { DeviceName } from "./identity/device-name";
export {
	type IncomingText,
	isNewerMark,
	type LiveNotes,
	type LiveTake,
} from "./live-notes";
export { restoreCutShort } from "./recovery/cut-short";
export { WriteJournal } from "./recovery/journal";
export { StatePersister } from "./recovery/state-persister";
export { PassphraseRotatedError } from "./remote/keyfile";
export { fetchRemoteManifest } from "./remote/manifest";
export { PassphraseManager } from "./remote/passphrase-manager";
export {
	insideOf,
	isUnder,
	nestedRoots,
	type Space,
	spaceOf,
	VAULT_SPACE,
	vaultPathOf,
} from "./remote/space";
export { canPullAll, canPushAll } from "./runtime/sync-gates";
export { configurationScopeSection } from "./scope/configuration-scope-section";
export { exclusionsSection } from "./scope/exclusions-section";
export {
	createIgnoreMatcher,
	type IgnoreMatcher,
	ignoreNoteOf,
	isIgnoreNote,
	loadSharedIgnoreMatcher,
} from "./scope/ignore";
export {
	type IgnoreStateHandle,
	registerIgnoreState,
} from "./scope/ignore-state";
export { createScopePolicy } from "./scope/scope";
export { projectSession } from "./session-state";
export {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
	type LiveMark,
	type Manifest,
	type ManifestAuthor,
	type ManifestEntry,
	type Move,
	type SkippedFile,
} from "./types";
export { type ChangeAction, changeActionOf } from "./ui/change-action";
export {
	addIgnoreMenuItem,
	carryVaultIgnores,
	stopIgnoring,
} from "./ui/ignore-action";
export {
	deepCleanOrphanedObjects,
	resetRemoteStorage,
	verifyRemoteIntegrity,
} from "./ui/maintenance-actions";
export { maintenanceSection } from "./ui/maintenance-section";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	confirmRevert,
} from "./ui/modals";
export { addPushMenuItem, pushScope, scopedPaths } from "./ui/push-action";
export { skippedFiles, skippedText } from "./ui/skipped";
export { runCompare, runPullAll, runPushAll } from "./ui/sync-actions";
export { registerVaultAdoptionPrompt } from "./ui/vault-adoption";
