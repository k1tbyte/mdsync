import type { Person } from "@/presence/people";

import { type LiveStatus, STATE_ICONS } from "./live-status";

export const LOCKED = "Read-only: shared with you to read";

export type NoteAction = "authors" | "reconnect" | "manage" | "rebuild";

export interface MenuItem {
	title: string;
	icon: string;
	checked?: boolean;
	action?: NoteAction;
}

export interface MenuFacts {
	locked: boolean;
	status: LiveStatus | null;
	edited: string | null;
	/** The relay refused or cannot be reached: a new socket may fix it. */
	relayDown: boolean;
	/** In a shared folder. */
	shared: boolean;
	/** A text note in a live room. */
	liveText: boolean;
	authorsShown: boolean;
}

export function infoItems({ locked, status, edited }: MenuFacts): MenuItem[] {
	const items: MenuItem[] = [];
	if (locked) items.push({ title: LOCKED, icon: "lock" });
	if (status) {
		items.push({ title: status.label, icon: STATE_ICONS[status.state] });
	}
	if (edited) items.push({ title: edited, icon: "pencil" });
	return items;
}

export function actionItems(facts: MenuFacts): MenuItem[] {
	const items: MenuItem[] = [];
	if (facts.liveText && facts.shared) {
		items.push({
			title: "Show who typed what",
			icon: "paintbrush",
			checked: facts.authorsShown,
			action: "authors",
		});
	}
	if (facts.relayDown) {
		items.push({ title: "Reconnect", icon: "refresh-cw", action: "reconnect" });
	}
	if (facts.shared) {
		items.push({
			title: "Manage shared folder",
			icon: "users",
			action: "manage",
		});
	}
	if (facts.liveText) {
		items.push({
			title: "Rebuild live note",
			icon: "hammer",
			action: "rebuild",
		});
	}
	return items;
}

/** Text notes show where each person is; other views have no cursor to follow. */
export function personState(
	{ idle }: Pick<Person, "idle">,
	hasCursor: boolean,
	cursorsShared: boolean,
): string {
	if (idle) return "away";
	if (hasCursor) return "go to cursor";
	return cursorsShared ? "no cursor here" : "Cursor not shared";
}
