const FOCUS_ATTRIBUTE = "data-obsync-focus";

export function focusKey<Element extends HTMLElement>(
	el: Element,
	key: string,
): Element {
	el.setAttr(FOCUS_ATTRIBUTE, key);
	return el;
}

export function renderKeepingFocus(
	container: HTMLElement,
	render: () => void,
): void {
	const focused = container.ownerDocument.activeElement;
	const key =
		focused && container.contains(focused)
			? focused.getAttribute(FOCUS_ATTRIBUTE)
			: null;
	render();
	if (key === null) return;
	container
		.querySelector<HTMLElement>(`[${FOCUS_ATTRIBUTE}="${key}"]`)
		?.focus();
}
