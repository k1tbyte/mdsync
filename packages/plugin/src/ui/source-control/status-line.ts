import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { formatRelativeTime } from "@/shared";
import type { SyncStatusSnapshot } from "@/sync/controller";
import { skippedText } from "@/ui/common";
import { askSpaceGone } from "@/ui/shares/space-gone";
import { actionButton } from "./action-button";
import type { SourceControlActions } from "./actions";
import { showFileList } from "./modals";

export function formatActionCount(count: number): string {
	return count.toLocaleString();
}

export function hasSyncError(snapshot: SyncStatusSnapshot): boolean {
	return Boolean(snapshot.error) || snapshot.spaceErrors.length > 0;
}

function listBadge(
	line: HTMLElement,
	icon: string,
	count: number,
	what: string,
	open: () => void,
): void {
	if (count === 0) return;
	const badge = line.createEl("button", {
		cls: `obsync-ignored-badge is-${icon}`,
	});
	setIcon(badge, icon);
	badge.createSpan({ text: formatActionCount(count) });
	badge.setAttr("aria-label", `Show ${count} ${what} files`);
	badge.addEventListener("click", open);
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
		for (const { root, message, gone } of snapshot.spaceErrors) {
			const row = line.createDiv({ text: `Error in "${root}": ${message}` });
			if (!gone) continue;
			actionButton(row, "warning")
				.setButtonText("Resolve…")
				.onClick(
					() => void askSpaceGone(plugin, plugin.controller.spaceFor(root)),
				);
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
	const ignored = snapshot.result?.snapshot.ignoredPaths ?? [];
	listBadge(line, "eye-off", ignored.length, "ignored", () =>
		showFileList(
			plugin.app,
			"Ignored files",
			"These files are excluded by shared syncignore.md rules or device-local ignore settings.",
			ignored.map((path) => ({ path })),
		),
	);
	const skipped = snapshot.result?.snapshot.skipped ?? [];
	const max = plugin.settings.maxFileBytes;
	listBadge(line, "cloud-off", skipped.length, "not synced", () =>
		showFileList(
			plugin.app,
			"Not synced",
			"These files stay on this device only until what is named below changes.",
			skipped.map((file) => ({
				path: file.path,
				detail: skippedText(file, max),
			})),
		),
	);
	const paused = plugin.spaces
		.partition()
		.filter((space) => space.paused)
		.map((space) => `"${space.root}"`);
	// Turned off on purpose: they would only nag.
	if (paused.length > 0 && plugin.settings.useSharedFolders) {
		line.createDiv({
			text: `Paused on this device, not compared: ${paused.join(", ")}.`,
		});
	}
	const full = plugin.spaces
		.partition()
		.filter(({ id }) => plugin.realtime.hub.statusOf(id) === "full")
		.map((space) => `"${space.root}"`);
	if (full.length > 0) {
		line.createDiv({
			text: `No room on the relay, they sync on the schedule: ${full.join(", ")}. Pause a shared folder you do not need here to make room.`,
		});
	}
}
