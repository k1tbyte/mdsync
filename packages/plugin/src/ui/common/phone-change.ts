import { type Component, Platform } from "obsidian";

export function redrawOnPhoneChange(
	view: Pick<Component, "register">,
	redraw: () => void,
): void {
	let phone = Platform.isPhone;
	const observer = new MutationObserver(() => {
		if (Platform.isPhone === phone) return;
		phone = Platform.isPhone;
		redraw();
	});
	observer.observe(document.body, {
		attributes: true,
		attributeFilter: ["class"],
	});
	view.register(() => observer.disconnect());
}
