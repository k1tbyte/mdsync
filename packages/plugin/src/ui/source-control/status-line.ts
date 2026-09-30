import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared/format";
import type { SyncStatusSnapshot } from "@/sync/controller";
import { actionButton } from "./action-button";
import type { SourceControlActions } from "./actions";
import { showIgnoredFiles } from "./modals";

export function formatActionCount(count: number): string {
	return count.toLocaleString();
}

export function hasSyncError(snapshot: SyncStatusSnapshot): boolean {
	return Boolean(snapshot.error) || snapshot.spaceErrors.length > 0;
}

export function fillStatusLine(
	line: HTMLElement,
	snapshot: SyncStatusSnapshot,
	plugin: PluginHost,
	actions: Pick<SourceControlActions, "adoptNewVault">,
): void {
	if (snapshot.error) {
		line.addClass("is-error");
		line.setText(`Error: ${snapshot.error}`);
		if (snapshot.error.includes("Remote vault id does not match local")) {
			actionButton(line, "warning")
				.setButtonText("Resolve vault mismatch")
				.onClick(() => void actions.adoptNewVault())
				.buttonEl.addClass("obsync-adopt-new-vault-btn");
		}
		return;
	}
	if (snapshot.busy) {
		line.setText(snapshot.progressText ?? "Syncing…");
		return;
	}
	if (snapshot.spaceErrors.length > 0) {
		line.addClass("is-error");
		for (const { root, message } of snapshot.spaceErrors) {
			line.createDiv({ text: `Error in "${root}": ${message}` });
		}
		line.createDiv({
			text: "Restore the folder, or stop sharing or leave it in Obsync settings (Sync tab).",
		});
		return;
	}
	if (snapshot.staleReason) {
		line.setText(snapshot.staleReason);
		return;
	}
	line.setText(
		snapshot.lastCompareAt
			? `Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
			: "Not compared yet",
	);
	if (snapshot.conflicts > 0) {
		line.createSpan({
			cls: "obsync-status-conflicts",
			text: ` · ${formatActionCount(snapshot.conflicts)} conflicts`,
		});
	}
	const ignoredPaths = snapshot.result?.snapshot.ignoredPaths ?? [];
	if (ignoredPaths.length > 0) {
		const ignoredBadge = line.createEl("button", {
			cls: "obsync-ignored-badge",
		});
		setIcon(ignoredBadge, "eye-off");
		ignoredBadge.createSpan({
			text: formatActionCount(ignoredPaths.length),
		});
		ignoredBadge.setAttr(
			"aria-label",
			`Show ${ignoredPaths.length} ignored files`,
		);
		ignoredBadge.addEventListener("click", () =>
			showIgnoredFiles(plugin.app, ignoredPaths),
		);
	}
	const paused = plugin.spaces
		.partition()
		.filter((space) => space.paused)
		.map((space) => `"${space.root}"`);
	if (paused.length > 0) {
		line.createDiv({
			text: `Paused on this device, not compared: ${paused.join(", ")}.`,
		});
	}
}
