import { MarkdownView, type Plugin } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { Rotation } from "@/live/session";
import type { PluginHost } from "@/plugin/host";
import { spaceOf, VAULT_SPACE } from "@/sync/space";
import {
	deepCleanOrphanedObjects,
	notifyError,
	notifyInfo,
	openDiffView,
	openShareWindow,
	openSourceControlDeleted,
	openSourceControlHistory,
	openSourceControlView,
	resetRemoteStorage,
	runWithNotice,
	shareAt,
	verifyRemoteIntegrity,
} from "@/ui";

const REBUILT: Record<Rotation, string> = {
	moved: "Live note rebuilt from its text.",
	refused: "The note changed meanwhile. Try again.",
	busy: "Still sending edits. Try again in a moment.",
};

export function registerCommands(plugin: Plugin & PluginHost): void {
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
		callback: () => void plugin.controller.refresh(),
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
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			const path = view?.file?.path;
			if (!path || !plugin.realtime.live.roomOf(path)) return false;
			if (checking) return true;
			void plugin.realtime.live
				.rotate(path)
				.then((outcome) => notifyInfo(REBUILT[outcome]));
			return true;
		},
	});

	plugin.addCommand({
		id: "toggle-live-authors",
		name: "Toggle authors in live notes",
		callback: () =>
			notifyInfo(
				plugin.realtime.live.toggleAuthors()
					? "Text others typed in live notes is tinted by author."
					: "Authors hidden.",
			),
	});

	plugin.addCommand({
		id: "manage-shared-folder",
		name: "Manage shared folder",
		checkCallback: (checking) => {
			const path = plugin.app.workspace.getActiveFile()?.path;
			if (path === undefined) return false;
			const { id, root } = spaceOf(plugin.spaces.partition(), path);
			const record = id === VAULT_SPACE.id ? undefined : shareAt(plugin, root);
			if (!record) return false;
			if (!checking) openShareWindow(plugin, record);
			return true;
		},
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
		// Always re-compare first: acting on a stale diff can push a file another
		// device has since changed, and can miss conflicts entirely.
		await plugin.controller.refresh();
		const snapshot = plugin.controller.getSnapshot();
		if (snapshot.error) throw new Error(snapshot.error);
		const diff = snapshot.result?.diff;
		if (await announceConflicts(plugin, diff?.conflicts.length ?? 0)) return;
		const paths = diff?.localChanges.map((c) => c.path) ?? [];
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
		const snapshot = plugin.controller.getSnapshot();
		if (snapshot.error) throw new Error(snapshot.error);
		const diff = snapshot.result?.diff;
		if (await announceConflicts(plugin, diff?.conflicts.length ?? 0)) return;
		const paths = diff?.remoteChanges.map((c) => c.path) ?? [];
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
