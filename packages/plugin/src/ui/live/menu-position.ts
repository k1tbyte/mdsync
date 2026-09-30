import type { Menu } from "obsidian";

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
