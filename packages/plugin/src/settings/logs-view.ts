import { Setting } from "obsidian";
import {
	ESyncLogLevel,
	ESyncLogOperation,
	type SyncLogEntry,
} from "@/logs/store";
import type { PluginHost } from "@/plugin/host";
import { formatTimestamp } from "@/shared";

const LOG_LEVEL_LABELS: Record<ESyncLogLevel, string> = {
	[ESyncLogLevel.Info]: "Info",
	[ESyncLogLevel.Warn]: "Warning",
	[ESyncLogLevel.Error]: "Error",
};

const LOG_LEVEL_CLASSES: Record<ESyncLogLevel, string> = {
	[ESyncLogLevel.Info]: "is-info",
	[ESyncLogLevel.Warn]: "is-warn",
	[ESyncLogLevel.Error]: "is-error",
};

const OPERATION_LABELS: Record<ESyncLogOperation, string> = {
	[ESyncLogOperation.Compare]: "Compare",
	[ESyncLogOperation.Push]: "Push",
	[ESyncLogOperation.Pull]: "Pull",
	[ESyncLogOperation.Reset]: "Reset",
	[ESyncLogOperation.Session]: "Session",
};

export function renderLogsView(
	parent: HTMLElement,
	plugin: PluginHost,
	onRefresh: () => void,
): void {
	new Setting(parent).setName("Logs").setHeading();
	parent.createEl("p", {
		text:
			"Compare, push, pull, reset and sync errors are recorded locally on this device. " +
			"Use Compare with remote from the command palette to inspect the current diff.",
	});

	new Setting(parent)
		.setName("Diagnostics")
		.setDesc(
			"Stored locally inside the MDSync plugin folder and excluded from sync.",
		)
		.addButton((button) =>
			button.setButtonText("Refresh").onClick(() => {
				onRefresh();
			}),
		)
		.addButton((button) =>
			button
				.setButtonText("Clear logs")
				.setDestructive()
				.onClick(async () => {
					await plugin.logs.clear();
					onRefresh();
				}),
		);

	const entries = plugin.logs.getEntries();
	if (entries.length === 0) {
		parent.createEl("p", { text: "No logs yet." });
		return;
	}

	const list = parent.createDiv({ cls: "mdsync-log-list" });
	for (const entry of entries) {
		renderLogEntry(list, entry);
	}
}

function renderLogEntry(parent: HTMLElement, entry: SyncLogEntry): void {
	const item = parent.createDiv({
		cls: `mdsync-log-entry ${LOG_LEVEL_CLASSES[entry.level]}`,
	});
	const meta = item.createDiv({ cls: "mdsync-log-meta" });
	meta.setText(
		`${formatTimestamp(entry.timestamp)} • ${OPERATION_LABELS[entry.operation]} • ${LOG_LEVEL_LABELS[entry.level]}`,
	);
	item.createDiv({ cls: "mdsync-log-message", text: entry.message });
	if (entry.details.length === 0) {
		return;
	}
	const details = item.createEl("details", { cls: "mdsync-log-details" });
	details.createEl("summary", { text: `Details (${entry.details.length})` });
	const list = details.createEl("ul");
	for (const detail of entry.details) {
		list.createEl("li", { text: detail });
	}
}
