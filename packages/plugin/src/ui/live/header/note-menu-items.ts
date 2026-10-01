import type { RelayFix } from "@/ui/common";
import { STATE_ICONS } from "@/ui/live/live-state";
import type { LiveStatus } from "./live-status";

export const LOCKED = "Read-only: shared with you to read";

export type NoteAction =
	| "authors"
	| "reconnect"
	| "relay-settings"
	| "manage"
	| "rebuild";

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
	relayFix: RelayFix | null;
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

/** A reader never writes the room. */
export function canRebuild({
	liveText,
	locked,
}: Pick<MenuFacts, "liveText" | "locked">): boolean {
	return liveText && !locked;
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
	if (facts.relayFix === "reconnect") {
		items.push({ title: "Reconnect", icon: "refresh-cw", action: "reconnect" });
	}
	if (facts.relayFix === "settings") {
		items.push({
			title: "Open relay settings",
			icon: "settings",
			action: "relay-settings",
		});
	}
	if (facts.shared) {
		items.push({ title: "Manage sharing", icon: "users", action: "manage" });
	}
	if (canRebuild(facts)) {
		items.push({
			title: "Rebuild live note",
			icon: "hammer",
			action: "rebuild",
		});
	}
	return items;
}

export interface PersonView {
	idle: boolean;
	following: boolean;
}

export function personState({ idle, following }: PersonView): string {
	if (following) return "following";
	return idle ? "follow (away)" : "follow";
}
