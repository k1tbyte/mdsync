import type { Menu } from "obsidian";

import type { Person } from "@/presence";
import { renderAvatar } from "./avatars";

export function infoTitle(text: string, state?: string): DocumentFragment {
	const title = createFragment();
	title.createSpan({ cls: "obsync-menu-info", text });
	if (state) title.createSpan({ cls: "obsync-person-state", text: state });
	return title;
}

export function personTitle(person: Person, state: string): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	title.createSpan({ cls: "obsync-person-state", text: state });
	return title;
}

export function showMenuAt(
	menu: Menu,
	anchor: HTMLElement | null | undefined,
	within: HTMLElement,
): void {
	if (anchor?.isShown()) {
		const { left, top, bottom } = anchor.getBoundingClientRect();
		const lower = top > anchor.win.innerHeight / 2;
		menu.showAtPosition({ x: left, y: lower ? top : bottom }, anchor.doc);
		return;
	}
	const { left, top, width, height } = within.getBoundingClientRect();
	menu.showAtPosition({ x: left + width / 2, y: top + height / 3 }, within.doc);
}
