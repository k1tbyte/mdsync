const HOLD_MS = 500;
/** A press that slides this far is a scroll, not a hold. */
const SLOP_PX = 10;
/** How long after the finger lifts that a hold still owns the click and contextmenu that follow. */
const RELEASE_GRACE_MS = 300;
const OWN_TAP_TARGETS = "button, label, input";

/**
 * Context menu on touch. Register before the element's click/contextmenu handlers: its suppressors must swallow
 * the hold's trailing click and Android's contextmenu. Preventing touchend stops a click retargeted onto the menu.
 */
export function onLongPress(
	el: HTMLElement,
	handler: (event: MouseEvent) => void,
): void {
	let timer: number | null = null;
	let origin: { x: number; y: number } | null = null;
	let pressing = false;
	let held = false;
	let graceTimer: number | null = null;

	const stopTimer = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		origin = null;
	};

	const stopGrace = (): void => {
		if (graceTimer !== null) window.clearTimeout(graceTimer);
		graceTimer = null;
	};

	const release = (): void => {
		stopTimer();
		pressing = false;
		if (!held) return;
		stopGrace();
		graceTimer = window.setTimeout(() => {
			graceTimer = null;
			held = false;
		}, RELEASE_GRACE_MS);
	};

	const open = (event: MouseEvent): void => {
		stopTimer();
		// The row may have been re-rendered away while the finger was down.
		if (!el.isConnected) return;
		held = true;
		handler(event);
	};

	el.addEventListener("click", (event) => {
		if (!held) return;
		held = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	});

	el.addEventListener("pointerdown", (event: PointerEvent) => {
		stopGrace();
		held = false;
		pressing = false;
		if (event.pointerType === "mouse" || startsOnTapTarget(el, event)) return;
		pressing = true;
		origin = { x: event.clientX, y: event.clientY };
		timer = window.setTimeout(() => open(event), HOLD_MS);
	});

	el.addEventListener("pointermove", (event: PointerEvent) => {
		if (!origin) return;
		const moved =
			Math.abs(event.clientX - origin.x) > SLOP_PX ||
			Math.abs(event.clientY - origin.y) > SLOP_PX;
		if (moved) stopTimer();
	});
	el.addEventListener("pointerup", release);
	el.addEventListener("pointercancel", release);
	el.addEventListener(
		"touchend",
		(event) => {
			if (held) event.preventDefault();
		},
		{ passive: false },
	);

	el.addEventListener("contextmenu", (event) => {
		if (!pressing && !held) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (timer !== null) open(event);
	});
}

function startsOnTapTarget(el: HTMLElement, event: Event): boolean {
	const control = (event.target as Element | null)?.closest?.(OWN_TAP_TARGETS);
	return Boolean(control) && control !== el;
}
