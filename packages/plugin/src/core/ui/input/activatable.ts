export function makeActivatable(
	el: HTMLElement,
	label: string | null,
	activate: () => void,
): void {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	if (label !== null) el.setAttr("aria-label", label);
	el.addEventListener("click", () => activate());
	el.addEventListener("keydown", (event: KeyboardEvent) => {
		// A key pressed on a control inside the element belongs to that control.
		if (event.target !== el) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		if (!event.repeat) activate();
	});
}
