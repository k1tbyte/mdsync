import { Menu } from "obsidian";
import type { PluginHost } from "@/app/host";
import { SOURCE_CONTROL_VIEW_TYPE } from "@/core/constants";
import { formatRelativeTime, pluralize } from "@/core/shared";
import { showMenuAt } from "@/core/ui";
import { openDiffView } from "@/features/diff";
import {
	openSourceControlChanges,
	openSourceControlView,
} from "@/features/source-control";
import {
	canPullAll,
	canPushAll,
	canSync,
	runPullAll,
	runPushAll,
	type SyncStatusSnapshot,
	splitSpaceErrors,
} from "@/features/sync";
import { addRelaySections } from "./where-menu";

/** The status bar item's menu, and on a phone the command's: where sync stands, what to do next, the relay. */
export function openStatusMenu(plugin: PluginHost, anchor?: HTMLElement): void {
	const menu = new Menu();
	const snapshot = plugin.controller.getSnapshot();
	menu.addItem((item) =>
		item.setTitle(summaryTitle(plugin, snapshot)).setIsLabel(true),
	);
	menu.addSeparator();
	addSyncActions(menu, plugin, snapshot);
	menu.addSeparator();
	addRelaySections(menu, plugin);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("Open source control")
			.setIcon("git-compare")
			.onClick(() => void openSourceControl(plugin)),
	);
	const { workspace } = plugin.app;
	const view = workspace.getMostRecentLeaf()?.view;
	showMenuAt(menu, anchor, view?.containerEl ?? workspace.containerEl);
}

function addSyncActions(
	menu: Menu,
	plugin: PluginHost,
	snapshot: SyncStatusSnapshot,
): void {
	if (!canSync(plugin.settings)) {
		menu.addItem((item) =>
			item
				.setTitle("Set up sync…")
				.setIcon("cloud")
				.onClick(() => plugin.openSetup()),
		);
		return;
	}
	if (snapshot.cancellable) {
		menu.addItem((item) =>
			item
				.setTitle("Cancel sync")
				.setIcon("x")
				.onClick(() => plugin.controller.cancel()),
		);
	}
	const conflicts = snapshot.result?.diff.conflicts ?? [];
	if (conflicts.length > 0) {
		// One conflict goes straight to its merge; more need the list.
		const only = conflicts.length === 1 ? conflicts[0] : undefined;
		menu.addItem((item) =>
			item
				.setTitle(
					only ? "Resolve conflict…" : `Resolve ${conflicts.length} conflicts…`,
				)
				.setIcon("triangle-alert")
				.onClick(
					() =>
						void (only
							? openDiffView(plugin, only.path, undefined, true)
							: openSourceControlChanges(plugin)),
				),
		);
	}
	if (snapshot.pendingLocal > 0) {
		menu.addItem((item) =>
			item
				.setTitle(`Push ${pluralize(snapshot.pendingLocal, "change")}`)
				.setIcon("arrow-up")
				.setDisabled(!canPushAll(snapshot))
				.onClick(() => void runPushAll(plugin)),
		);
	}
	if (snapshot.pendingRemote > 0) {
		menu.addItem((item) =>
			item
				.setTitle(`Pull ${pluralize(snapshot.pendingRemote, "change")}`)
				.setIcon("arrow-down")
				.setDisabled(!canPullAll(snapshot))
				.onClick(() => void runPullAll(plugin)),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("Compare now")
			.setIcon("refresh-cw")
			.setDisabled(snapshot.busy)
			.onClick(() => void plugin.controller.refreshFromDisk()),
	);
}

function summaryTitle(
	plugin: PluginHost,
	snapshot: SyncStatusSnapshot,
): DocumentFragment {
	const title = createFragment();
	title.createDiv({
		cls: "mdsync-menu-info mdsync-menu-headline",
		text: syncHeadline(plugin, snapshot),
	});
	const detail =
		snapshot.error ??
		(snapshot.lastCompareAt
			? `Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
			: null);
	if (detail) title.createDiv({ cls: "mdsync-menu-detail", text: detail });
	return title;
}

/** "3 to push · 1 conflict": the menu's head, and what the status bar item announces. */
export function syncHeadline(
	plugin: PluginHost,
	snapshot: SyncStatusSnapshot,
): string {
	if (!canSync(plugin.settings)) return "Sync is not set up";
	if (snapshot.offline) return "Offline";
	if (snapshot.error) return "Sync stopped";
	if (snapshot.busy) return snapshot.progressText ?? "Syncing…";
	if (!snapshot.result) return "Not compared yet";
	const { pendingLocal, pendingRemote, conflicts } = snapshot;
	const { broken, unreachable } = splitSpaceErrors(snapshot.spaceErrors);
	const parts = [
		pendingLocal > 0 ? `${pendingLocal} to push` : null,
		pendingRemote > 0 ? `${pendingRemote} to pull` : null,
		conflicts > 0 ? pluralize(conflicts, "conflict") : null,
		broken.length > 0
			? `${pluralize(broken.length, "shared folder")} failed`
			: null,
		unreachable.length > 0
			? `${pluralize(unreachable.length, "shared folder")} offline`
			: null,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : "Everything is in sync";
}

async function openSourceControl(plugin: PluginHost): Promise<void> {
	await openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
}
