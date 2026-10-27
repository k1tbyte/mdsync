/** Pixels a second the text travels. */
const SLIDE_PX_PER_S = 40;
/** Share of the cycle spent sliding each way: `mdsync-slide` in base/marquee.css. */
const SLIDE_SHARE = 0.35;
/** A line cut by a pixel or two would otherwise shake. */
const MIN_CYCLE_S = 4;

/** One line too long for `el` slides to its end and back; one that fits stays put. Measured next frame. */
export function slideWhenCut(el: HTMLElement): void {
	const text = createSpan({ cls: "mdsync-marquee-text" });
	text.append(...Array.from(el.childNodes));
	el.addClass("mdsync-marquee");
	el.appendChild(text);
	// By then the rest of its row is drawn.
	requestAnimationFrame(() => measureSlide(el));
}

/** Again once its box may have changed: a hidden one measured nothing. */
export function measureSlide(el: HTMLElement): void {
	const text = el.querySelector<HTMLElement>(".mdsync-marquee-text");
	if (!el.isConnected || !text) return;
	const shift = text.offsetWidth - el.clientWidth;
	el.toggleClass("is-sliding", shift > 0);
	if (shift <= 0) return;
	el.style.setProperty("--mdsync-slide", `${-shift}px`);
	el.style.setProperty(
		"--mdsync-slide-time",
		`${Math.max(MIN_CYCLE_S, shift / SLIDE_PX_PER_S / SLIDE_SHARE)}s`,
	);
}
