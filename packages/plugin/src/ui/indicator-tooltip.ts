/** Obsidian renders `aria-label` as its own tooltip; a native `title` would double it. */
export function setIndicatorTooltip(
	target: HTMLElement,
	tooltip: string,
): void {
	target.setAttr("aria-label", tooltip);
}
