import {
	ExtraButtonComponent,
	Setting,
	type SettingDefinitionPage,
} from "obsidian";
import {
	ESyncLogLevel,
	ESyncLogOperation,
	type SyncLogEntry,
} from "@/logs/store";
import type { PluginHost } from "@/plugin/host";
import { formatTimestamp, pluralize } from "@/shared";
import { copyText } from "@/ui/common";
import { imperativePage } from "./page";

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

const RECENT_ERRORS_MS = 24 * 60 * 60 * 1000;

export function logsPage(plugin: PluginHost): SettingDefinitionPage {
	const recentErrors = (): number => {
		const since = Date.now() - RECENT_ERRORS_MS;
		return plugin.logs
			.getEntries()
			.filter((e) => e.level === ESyncLogLevel.Error && e.timestamp >= since)
			.length;
	};
	return {
		type: "page",
		name: "Logs",
		desc: "Diagnostics stored on this device only.",
		displayValue: () => {
			const count = recentErrors();
			return count ? pluralize(count, "error") : "";
		},
		status: () => (recentErrors() ? "warning" : null),
		page: () =>
			imperativePage("Logs", (parent, refresh) =>
				renderLogsView(parent, plugin, refresh),
			),
	};
}

function renderLogsView(
	parent: HTMLElement,
	plugin: PluginHost,
	onRefresh: () => void,
): void {
	parent.createEl("p", {
		text:
			"Compare, push, pull, reset and sync errors are recorded locally on this device. " +
			"Use Compare with remote from the command palette to inspect the current diff.",
	});

	const entries = plugin.logs.getEntries();
	const diagnostics = new Setting(parent)
		.setName("Diagnostics")
		.setDesc(
			"Stored locally inside the MDSync plugin folder and excluded from sync.",
		);
	if (entries.length > 0) {
		diagnostics.addButton((button) =>
			button
				.setButtonText("Copy logs")
				.onClick(
					() => void copyText("Logs", entries.map(logText).join("\n\n")),
				),
		);
	}
	diagnostics
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

	if (entries.length === 0) {
		parent.createEl("p", { text: "No logs yet." });
		return;
	}

	const list = parent.createDiv({ cls: "mdsync-log-list" });
	for (const entry of entries) {
		renderLogEntry(list, entry);
	}
}

export function renderLogEntry(parent: HTMLElement, entry: SyncLogEntry): void {
	const item = parent.createDiv({
		cls: `mdsync-log-entry ${LOG_LEVEL_CLASSES[entry.level]}`,
	});
	const meta = item.createDiv({ cls: "mdsync-log-meta" });
	meta.createSpan({ text: logMeta(entry) });
	new ExtraButtonComponent(meta)
		.setIcon("copy")
		.setTooltip("Copy entry")
		.onClick(() => void copyText("Log entry", logText(entry)));
	item.createDiv({ cls: "mdsync-log-message", text: entry.message });
	if (entry.details.length === 0) {
		return;
	}
	const details = item.createEl("details", { cls: "mdsync-log-details" });
	details.createEl("summary", { text: `Details (${entry.details.length})` });
	// Up to 200 entries x 50 details stay unbuilt until someone opens one.
	details.addEventListener(
		"toggle",
		() => {
			const list = details.createEl("ul");
			for (const detail of entry.details) {
				list.createEl("li", { text: detail });
			}
		},
		{ once: true },
	);
}

function logMeta(entry: SyncLogEntry): string {
	return `${formatTimestamp(entry.timestamp)} • ${OPERATION_LABELS[entry.operation]} • ${LOG_LEVEL_LABELS[entry.level]}`;
}

/** What the entry shows, details expanded, as plain text. */
function logText(entry: SyncLogEntry): string {
	return [
		logMeta(entry),
		entry.message,
		...entry.details.map((detail) => `- ${detail}`),
	].join("\n");
}
