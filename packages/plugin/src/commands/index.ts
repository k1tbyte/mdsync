import { MarkdownView, type Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import { type LinkRecord, linkError, noteLinks, onRelay } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { spaceOf } from "@/sync/space";
import type { DiffResult } from "@/sync/types";
import {
	canRebuild,
	deepCleanOrphanedObjects,
	isLinkable,
	notifyError,
	notifyInfo,
	openDiffView,
	openInvite,
	openManageLinks,
	openShareLink,
	openShareWindow,
	openSourceControlDeleted,
	openSourceControlHistory,
	openSourceControlView,
	openWhereMenu,
	rebuildLiveNote,
	resetRemoteStorage,
	runWithNotice,
	toggleAuthors,
	updateSharedLink,
	verifyRemoteIntegrity,
} from "@/ui";

export function registerCommands(
	plugin: Plugin & PluginHost,
	openNoteMenu: (checking: boolean) => boolean,
): void {
	plugin.addCommand({
		id: "compare",
		name: "Compare with remote",
		callback: () => void runCompare(plugin),
	});

	plugin.addCommand({
		id: "push",
		name: "Push all local changes",
		callback: () => void runPushAll(plugin),
	});

	plugin.addCommand({
		id: "pull",
		name: "Pull all remote changes",
		callback: () => void runPullAll(plugin),
	});

	plugin.addCommand({
		id: "open-source-control",
		name: "Open source control",
		callback: () =>
			void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE),
	});

	plugin.addCommand({
		id: "refresh",
		name: "Refresh sync status",
		callback: () => void plugin.controller.refreshFromDisk(),
	});

	plugin.addCommand({
		id: "reset-remote-storage",
		name: "Reset remote storage",
		callback: () => void resetRemoteStorageCommand(plugin),
	});

	plugin.addCommand({
		id: "forget-passphrase",
		name: "Forget cached passphrase",
		callback: async () => {
			await plugin.passphrase.forget();
			notifyInfo("Passphrase forgotten.");
		},
	});

	plugin.addCommand({
		id: "file-history",
		name: "Show file history",
		checkCallback: (checking) => {
			if (!plugin.settings.fileHistoryEnabled) return false;
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return false;
			if (checking) return true;
			void openSourceControlHistory(plugin, file.path);
			return true;
		},
	});

	plugin.addCommand({
		id: "restore-deleted-files",
		name: "Restore deleted files",
		checkCallback: (checking) => {
			if (!plugin.settings.fileHistoryEnabled) return false;
			if (checking) return true;
			void openSourceControlDeleted(plugin);
			return true;
		},
	});

	plugin.addCommand({
		id: "verify-remote-integrity",
		name: "Verify remote integrity",
		callback: () => void verifyRemoteIntegrity(plugin),
	});

	plugin.addCommand({
		id: "deep-clean-orphans",
		name: "Deep-clean orphaned objects",
		callback: () => void deepCleanOrphanedObjects(plugin),
	});

	plugin.addCommand({
		id: "rebuild-live-note",
		name: "Rebuild live note",
		checkCallback: (checking) => {
			const path =
				plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
			if (!path) return false;
			const liveText = plugin.realtime.live.roomOf(path) !== null;
			const locked = spaceOf(plugin.spaces.partition(), path).readOnly === true;
			if (!canRebuild({ liveText, locked })) return false;
			if (checking) return true;
			rebuildLiveNote(plugin, path);
			return true;
		},
	});

	plugin.addCommand({
		id: "toggle-live-authors",
		name: "Toggle authors in live notes",
		callback: () => toggleAuthors(plugin),
	});

	plugin.addCommand({
		id: "show-live-status",
		name: "Show relay status",
		callback: () => openWhereMenu(plugin),
	});

	plugin.addCommand({
		id: "show-note-live-menu",
		name: "Show live menu of this note",
		checkCallback: openNoteMenu,
	});

	plugin.addCommand({
		id: "manage-shared-folder",
		name: "Manage sharing",
		checkCallback: (checking) => {
			const path = plugin.app.workspace.getActiveFile()?.path;
			if (path === undefined || !plugin.settings.useSharedFolders) return false;
			const space = spaceOf(plugin.spaces.partition(), path);
			const record = plugin.spaces.shareOf(space);
			if (!record) return false;
			if (!checking) openShareWindow(plugin, record);
			return true;
		},
	});

	plugin.addCommand({
		id: "share-note-link",
		name: "Share this note as a link",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!isLinkable(plugin.app, file)) return false;
			if (!checking) openShareLink(plugin, file);
			return true;
		},
	});

	plugin.addCommand({
		id: "update-note-links",
		name: "Update share links of this note",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return false;
			const records = noteLinks(plugin, file.path)?.records.filter((record) =>
				onRelay(record, plugin.settings),
			);
			if (records === undefined || records.length === 0) return false;
			if (!checking) void updateNoteLinks(plugin, records);
			return true;
		},
	});

	plugin.addCommand({
		id: "manage-note-links",
		name: "Manage share links",
		callback: () => openManageLinks(plugin),
	});

	plugin.addCommand({
		id: "accept-shared-folder-invite",
		name: "Accept shared folder invite",
		callback: () => void openInvite(plugin),
	});

	plugin.addCommand({
		id: "open-diff-active-file",
		name: "Open diff for active file",
		checkCallback: (checking) => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const path = view?.file?.path;
			if (!path) return false;
			const status = plugin.controller.fileDiffs.getStatusForPath(path);
			if (!status) return false;
			if (checking) return true;
			void openDiffView(plugin, path);
			return true;
		},
	});
}

async function updateNoteLinks(
	plugin: PluginHost,
	records: LinkRecord[],
): Promise<void> {
	for (const record of records) {
		try {
			await updateSharedLink(plugin, record);
		} catch (err) {
			notifyError("Could not change the link", linkError(err));
		}
	}
}

async function runCompare(plugin: Plugin & PluginHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	} catch (err) {
		notifyError("Compare failed", err);
	}
}

async function runPushAll(plugin: Plugin & PluginHost): Promise<void> {
	try {
		// Re-compare first: a stale diff can push a file another device changed, or miss conflicts.
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff.conflicts.length))) {
			return;
		}
		// A read-only share's changes cannot go out; they must not hold back the rest.
		const paths = diff.localChanges
			.map((c) => c.path)
			.filter((path) => !plugin.controller.spaceFor(path).readOnly);
		if (paths.length === 0) {
			notifyInfo("Nothing to push.");
			return;
		}
		await runWithNotice(
			() => plugin.controller.pushPaths(paths),
			`Pushed ${paths.length} file(s).`,
			"Push all failed",
		);
	} catch (err) {
		notifyError("Push all failed", err);
	}
}

async function runPullAll(plugin: Plugin & PluginHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff.conflicts.length))) {
			return;
		}
		const paths = diff.remoteChanges.map((c) => c.path);
		if (paths.length === 0) {
			notifyInfo("Nothing to pull.");
			return;
		}
		await runWithNotice(
			() => plugin.controller.pullPaths(paths),
			`Pulled ${paths.length} file(s).`,
			"Pull all failed",
		);
	} catch (err) {
		notifyError("Pull all failed", err);
	}
}

/** The fresh compare's diff; null, said so, when the compare did not finish. */
function comparedDiff(plugin: PluginHost): DiffResult | null {
	const { error, result } = plugin.controller.getSnapshot();
	if (error) throw new Error(error);
	if (!result) notifyInfo("The compare did not finish. Try again.");
	return result?.diff ?? null;
}

/** Push and pull must never choose a side silently; conflicts go to the user. */
async function announceConflicts(
	plugin: Plugin & PluginHost,
	count: number,
): Promise<boolean> {
	if (count === 0) return false;
	notifyInfo(`Resolve ${count} conflict(s) first.`);
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	return true;
}

async function resetRemoteStorageCommand(
	plugin: Plugin & PluginHost,
): Promise<void> {
	if (!(await resetRemoteStorage(plugin))) return;
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
}
