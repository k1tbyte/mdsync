import type { Setting } from "obsidian";
import { errorMessage } from "@/core/shared";
import { alertLine } from "@/core/ui";
import type { SnapshotListResult } from "../../history/types";
import { renderActivityCalendar } from "./activity-calendar";
import { buildCalendar, type CalendarDay, ladderOf } from "./calendar";

export interface HoldsOptions {
	load: () => Promise<SnapshotListResult>;
	horizon: number | null;
	onPick: (day: CalendarDay) => void;
}

/** **What history holds**: a year of pushes over how each stretch is kept, then the ladder for `horizon`. */
export function renderHistoryHolds(
	setting: Setting,
	{ load, horizon, onPick }: HoldsOptions,
): void {
	setting.setClass("mdsync-holds");
	const body = setting.settingEl.createDiv({ cls: "mdsync-holds-body" });
	const calendar = body.createDiv({
		cls: "mdsync-holds-calendar",
		text: "Reading history…",
	});
	const ladder = body.createDiv({ cls: "mdsync-holds-ladder" });
	for (const step of ladderOf(horizon)) {
		const card = ladder.createDiv({
			cls: "mdsync-holds-step",
			attr: { "data-res": step.res },
		});
		card.createDiv({ cls: "mdsync-holds-ticks" });
		card.createDiv({ cls: "mdsync-holds-title", text: step.title });
		card.createDiv({ cls: "mdsync-holds-span", text: step.span });
	}
	load().then(
		(result) => {
			calendar.empty();
			renderActivityCalendar(
				calendar,
				buildCalendar(result.activity, result.snapshots),
				{ onPick },
			);
		},
		(error: unknown) => {
			calendar.empty();
			alertLine(calendar).setText(
				`Could not read history: ${errorMessage(error)}`,
			);
		},
	);
}
