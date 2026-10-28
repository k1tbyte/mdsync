import { ButtonComponent } from "obsidian";
import { closePluginSettings } from "@/core/hub";
import { formatRelativeTime, pluralize } from "@/core/shared";
import {
	activeStorage,
	isStorageConfigured,
	storageIdentity,
} from "@/features/storage";
import { buildCalendar, renderActivityCalendar } from "@/features/sync";
import type { SettingsTabHost } from "./host";

/** A year of the vault's pushes as this device last read them: no request, so nothing until history is read once. */
export function renderActivityCard(
	parent: HTMLElement,
	plugin: SettingsTabHost,
): void {
	const { settings } = plugin;
	if (!settings.fileHistoryEnabled || !isStorageConfigured(settings)) return;
	const cached = plugin.controller.activity.recall(
		storageIdentity(activeStorage(settings)),
	);
	if (!cached) return;
	const open = (day?: number): void => {
		closePluginSettings(plugin.app);
		void plugin.openTimeline(day);
	};
	const calendar = buildCalendar(cached.activity, null);
	const card = parent.createDiv({
		cls: "mdsync-overview-card mdsync-overview-activity",
	});
	const head = card.createDiv({ cls: "mdsync-overview-activity-head" });
	const text = head.createDiv();
	text.createDiv({ cls: "mdsync-overview-card-title", text: "Activity" });
	text.createDiv({
		cls: "mdsync-overview-card-lines",
		text: `${pluralize(calendar.pushes, "push", "pushes")} in the last year · updated ${formatRelativeTime(cached.at)}`,
	});
	new ButtonComponent(head)
		.setButtonText("Open timeline")
		.onClick(() => open());
	renderActivityCalendar(card, calendar, { onPick: (day) => open(day.start) });
}
