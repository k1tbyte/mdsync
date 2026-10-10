export { addIgnoreMenuItem } from "./actions/ignore-action";
export {
	deepCleanOrphanedObjects,
	resetLocalState,
	resetRemoteStorage,
	verifyRemoteIntegrity,
} from "./actions/maintenance-actions";
export { addPushMenuItem } from "./actions/push-action";
export {
	notifyAction,
	notifyError,
	notifyInfo,
	reportError,
	runWithNotice,
} from "./common/notices";
export {
	openInEditor,
	revealInFileExplorer,
} from "./common/obsidian-helpers";
export { DiffView } from "./diff-view";
export { registerFileContextIndicators } from "./explorer/file-context-indicators";
export { registerFileExplorerIndicators } from "./explorer/file-explorer-indicators";
export type { IndicatorHandle } from "./explorer/indicator-handle";
export {
	addLinkMenuItems,
	isLinkable,
	openManageLinks,
	openShareLink,
	registerNoteLinkActions,
	updateSharedLinks,
} from "./links";
export { createDeletedElsewhere } from "./live/deleted-elsewhere";
export { rebuildLiveNote, toggleAuthors } from "./live/header/live-actions";
export { canRebuild } from "./live/header/note-menu-items";
export { registerNotePresence } from "./live/header/note-presence";
export { registerLiveStatusBar } from "./live/status/live-status-bar";
export { openWhereMenu } from "./live/status/where-menu";
export {
	askNewPassphrase,
	askPassphrase,
	askSettingsTransferInput,
	confirmRemoteReset,
	confirmSettingsTransferImport,
	openConfirmModal,
	openPromiseModal,
	showSettingsTransferExport,
} from "./modals";
export { registerRibbon } from "./ribbon";
export { createAccessEnded } from "./shares/access-ended";
export { openInvite } from "./shares/invite-action";
export { shareSummary } from "./shares/share-summary";
export { addShareMenuItem, openShareWindow } from "./shares/share-window";
export { createSpaceGone } from "./shares/space-gone";
export {
	confirmAdoptNewVault,
	confirmBatchResolve,
	showFileList,
} from "./source-control";
export {
	openDiffView,
	openSourceControlDeleted,
	openSourceControlHistory,
	openSourceControlView,
	SourceControlView,
} from "./source-control-view";
export { registerStatusBar } from "./status-bar";
