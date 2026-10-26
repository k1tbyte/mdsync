import { ButtonComponent, Menu } from "obsidian";

import type { Person } from "@/presence";
import type { Participant } from "@/storage";
import {
	appendIconButton,
	appendLabeledButton,
	focusKey,
	renderAvatar,
	showMenuAt,
} from "@/ui/common";
import type { ShareRow } from "./share-people";

export interface PeopleActions {
	follow: (person: Person) => void;
	open: (note: string) => void;
	/** Absent where this device cannot revoke. */
	revoke?: (participant: Participant) => void;
}

/** This person first, then the others: who, where, their role and what to do with them. */
export function renderPeople(
	list: HTMLElement,
	self: ShareRow,
	rows: readonly ShareRow[],
	actions: PeopleActions,
): void {
	renderRow(list, self, true);
	for (const row of rows)
		renderActions(renderRow(list, row, false), row, actions);
}

function renderRow(
	list: HTMLElement,
	row: ShareRow,
	self: boolean,
): HTMLElement {
	const { key, name, person } = row;
	const el = list.createDiv({ cls: "mdsync-modal-row mdsync-share-person" });
	// Dimmed while not here, as their ring is everywhere else.
	const away = !self && (person === null || person.idle);
	renderAvatar(el, { key, name, idle: away });
	const text = el.createDiv({ cls: "mdsync-modal-row-text" });
	text.createDiv({
		cls: "mdsync-modal-row-name",
		text: self ? "You" : name,
	});
	text.createDiv({ cls: "mdsync-modal-row-detail", text: row.detail });
	if (row.role) {
		el.createSpan({
			cls: `mdsync-share-role${row.role === "Owner" ? " is-owner" : ""}`,
			text: row.role,
		});
	}
	return el;
}

/** Follow leads where they are at a note; the rest waits in the row's menu, or stands alone when it is all. */
function renderActions(
	el: HTMLElement,
	{ key, name, person, participant }: ShareRow,
	{ follow, open, revoke }: PeopleActions,
): void {
	const note = person?.note ?? null;
	const canRevoke = revoke && participant ? () => revoke(participant) : null;
	if (person && note !== null) {
		const follows = appendLabeledButton(el, "eye", "Follow", () =>
			follow(person),
		);
		focusKey(follows, `follow-${key}`);
		const more = appendIconButton(
			el,
			"more-horizontal",
			`More for ${name}`,
			() => {
				const menu = new Menu();
				menu.addItem((item) =>
					item
						.setTitle(`Open ${note.slice(note.lastIndexOf("/") + 1)}`)
						.setIcon("file-text")
						.onClick(() => open(note)),
				);
				if (canRevoke) {
					menu.addItem((item) =>
						item
							.setTitle("Revoke access")
							.setIcon("user-x")
							.setWarning(true)
							.onClick(canRevoke),
					);
				}
				showMenuAt(menu, more, el);
			},
		);
		// One key with Revoke: arriving at a note swaps one for the other, and the focus moves along.
		focusKey(more, `manage-${key}`);
		return;
	}
	if (!canRevoke) return;
	const button = new ButtonComponent(el)
		.setButtonText("Revoke")
		.setDestructive()
		.onClick(canRevoke);
	focusKey(button.buttonEl, `manage-${key}`);
}
