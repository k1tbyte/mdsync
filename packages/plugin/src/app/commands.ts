import { MarkdownView, type Plugin } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import { notifyInfo } from "@/core/ui";
import { type ActiveMerge, DiffView, openDiffView } from "@/features/diff";
import {
	isLinkable,
	noteLinks,
	onRelay,
	openManageLinks,
	openShareLink,
	updateSharedLinks,
} from "@/features/links";
import {
	canRebuild,
	rebuildLiveNote,
	toggleAuthors,
} from "@/features/note-header";
import {
	openSourceControlDeleted,
	openSourceControlHistory,
	openSourceControlView,
} from "@/features/source-control";
import { openInvite, openShareWindow } from "@/features/spaces";
import { openStatusMenu } from "@/features/status";
import {
	deepCleanOrphanedObjects,
	resetRemoteStorage,
	runCompare,
	runPullAll,
	runPushAll,
	spaceOf,
	verifyRemoteIntegrity,
} from "@/features/sync";
import type { PluginHost } from "./host";

/** Shown only while the active view merges; the change is the one at the cursor. */
const MERGE_COMMANDS: readonly [
	string,
	string,
	(merge: ActiveMerge) => void,
][] = [
	["merge-take-local", "Take local in merge", (m) => m.take(["local"])],
	["merge-take-remote", "Take remote in merge", (m) => m.take(["remote"])],
	[
		"merge-take-both",
		"Take both in merge, local first",
		(m) => m.take(["local", "remote"]),
	],
	["merge-next-conflict", "Go to next merge conflict", (m) => m.nextConflict()],
	["merge-save", "Save merge result", (m) => m.save()],
];

export function registerCommands(
	plugin: Plugin & PluginHost,
	openNoteMenu: (checking: boolean) => boolean,
): void {
	plugin.addCommand({
		id: "open-setup-wizard",
		name: "Set up sync",
		callback: () => plugin.openSetup(),
	});

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
		name: "Show sync and relay status",
		callback: () => openStatusMenu(plugin),
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
			if (!checking) void updateSharedLinks(plugin, records);
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

	for (const [id, name, run] of MERGE_COMMANDS) {
		plugin.addCommand({
			id,
			name,
			checkCallback: (checking) => {
				const merge = plugin.app.workspace.getActiveViewOfType(DiffView)?.merge;
				if (!merge) return false;
				if (!checking) run(merge);
				return true;
			},
		});
	}

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

async function resetRemoteStorageCommand(
	plugin: Plugin & PluginHost,
): Promise<void> {
	if (!(await resetRemoteStorage(plugin))) return;
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
}
