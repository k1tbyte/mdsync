import type { Plugin } from "obsidian";

import { SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import { formatRelativeTime } from "@/shared";
import type { SyncController, SyncStatusSnapshot } from "@/sync/controller";
import { makeActivatable } from "./common/activatable";
import { openSourceControlView } from "./source-control-view";

export function registerStatusBar(
	plugin: Plugin,
	controller: SyncController,
): void {
	const root = plugin.addStatusBarItem();
	root.addClass("mdsync-status-bar");
	makeActivatable(root, "Open MDSync source control", () => {
		void openSourceControlView(plugin.app, SOURCE_CONTROL_VIEW_TYPE);
	});

	const spinner = root.createSpan({
		cls: "mdsync-status-spinner mdsync-hidden",
	});
	const text = root.createSpan();

	const render = (snapshot: SyncStatusSnapshot): void => {
		const offline = !navigator.onLine;
		spinner.toggleClass("mdsync-hidden", !snapshot.busy || offline);
		root.toggleClass("is-error", hasError(snapshot) && !offline);
		root.toggleClass("is-offline", offline);
		text.setText(offline ? "MDSync: offline" : formatStatus(snapshot));
		root.setAttr(
			"aria-label",
			offline
				? "No network connection. MDSync will sync once it is back."
				: buildTooltip(snapshot),
		);
	};

	render(controller.getSnapshot());
	const unsubscribe = controller.subscribe(render);
	plugin.register(unsubscribe);
	// A dropped connection must not read as a broken remote.
	const renderCurrent = (): void => render(controller.getSnapshot());
	plugin.registerDomEvent(window, "online", renderCurrent);
	plugin.registerDomEvent(window, "offline", renderCurrent);
}

function formatStatus(snapshot: SyncStatusSnapshot): string {
	if (hasError(snapshot)) return `MDSync: error`;
	if (snapshot.busy) return `MDSync: syncing…`;
	const parts: string[] = [];
	if (snapshot.pendingLocal > 0) parts.push(`↑${snapshot.pendingLocal}`);
	if (snapshot.pendingRemote > 0) parts.push(`↓${snapshot.pendingRemote}`);
	if (snapshot.conflicts > 0) parts.push(`⚠${snapshot.conflicts}`);
	if (parts.length === 0) return "MDSync: clean";
	return `MDSync: ${parts.join(" ")}`;
}

function buildTooltip(snapshot: SyncStatusSnapshot): string {
	if (snapshot.error) return `MDSync error: ${snapshot.error}`;
	if (hasError(snapshot)) {
		const failed = snapshot.spaceErrors.map(
			({ root, message }) => `"${root}": ${message}`,
		);
		return `MDSync error in ${failed.join("; ")}`;
	}
	const last = snapshot.lastCompareAt
		? `Last compared ${formatRelativeTime(snapshot.lastCompareAt)}`
		: "Not compared yet";
	return `${last}. Select to open source control.`;
}

/** A shared folder that failed counts: the rest syncs, it does not. */
function hasError(snapshot: SyncStatusSnapshot): boolean {
	return Boolean(snapshot.error) || snapshot.spaceErrors.length > 0;
}
