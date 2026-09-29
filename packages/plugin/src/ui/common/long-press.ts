const HOLD_MS = 500;
/** A press that slides this far is a scroll, not a hold. */
const SLOP_PX = 10;

/**
 * Opens a context menu on touch, which has neither a right click nor the hover
 * that reveals a row's menu button.
 *
 * Register this before any click handler on the same element: the suppressor it
 * installs has to run first to swallow the click the hold ends with.
 */
export function onLongPress(
	el: HTMLElement,
	handler: (event: PointerEvent) => void,
): void {
	let timer: number | null = null;
	let origin: { x: number; y: number } | null = null;
	let held = false;

	const cancel = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		origin = null;
	};

	el.addEventListener("click", (event) => {
		if (!held) return;
		held = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	});

	el.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.pointerType === "mouse") return;
		origin = { x: event.clientX, y: event.clientY };
		timer = window.setTimeout(() => {
			timer = null;
			origin = null;
			// The row may have been re-rendered away while the finger was down.
			if (!el.isConnected) return;
			held = true;
			handler(event);
		}, HOLD_MS);
	});

	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (!origin) return;
		const moved =
			Math.abs(event.clientX - origin.x) > SLOP_PX ||
			Math.abs(event.clientY - origin.y) > SLOP_PX;
		if (moved) cancel();
	});
	el.addEventListener("pointerup", cancel);
	el.addEventListener("pointercancel", cancel);
}
