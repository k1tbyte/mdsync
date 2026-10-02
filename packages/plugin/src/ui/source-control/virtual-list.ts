/**
 * Windows a long list against a scroll container that is not the list itself: the whole pane scrolls.
 * Fixed-pitch absolute rows give the list its full height from the first frame, so the scrollbar never jumps.
 */

/** Used until a row can be measured, which a hidden view cannot do. */
const FALLBACK_PITCH_PX = 26;

const OVERSCAN_ROWS = 8;

export interface VirtualListHandle {
	setCount(count: number): void;
	/** Re-windows after the list moved without the scroller scrolling. */
	refresh(): void;
	destroy(): void;
}

export interface VirtualListOptions {
	scroller: HTMLElement;
	/** Emptied and taken over; rows are appended here. */
	container: HTMLElement;
	count: number;
	/** Builds row `index`, already appended to the container. */
	renderRow: (index: number) => HTMLElement;
}

export function mountVirtualList(
	options: VirtualListOptions,
): VirtualListHandle {
	const { scroller, container, renderRow } = options;
	let count = options.count;
	// Measured with the class already on: windowed rows carry styles of their
	// own, and a pitch taken from the flow layout would not be the one they get.
	container.addClass("is-virtual");
	let pitch = measureRows(container, renderRow, count);
	let measured = pitch > 0;
	if (!measured) pitch = FALLBACK_PITCH_PX;
	applyPitch(container, pitch, measured);
	const mounted = new Map<number, HTMLElement>();
	let frame = 0;

	const remount = (): void => {
		for (const el of mounted.values()) el.remove();
		mounted.clear();
		container.style.height = `${count * pitch}px`;
	};

	const update = (): void => {
		frame = 0;
		const box = container.getBoundingClientRect();
		// A collapsed section is display:none, where every rect reads zero and
		// the window would be computed from nonsense.
		if (box.width === 0) return;
		const scrolled = scroller.getBoundingClientRect().top - box.top;
		const first = Math.max(0, Math.floor(scrolled / pitch) - OVERSCAN_ROWS);
		const last = Math.min(
			count - 1,
			Math.ceil((scrolled + scroller.clientHeight) / pitch) + OVERSCAN_ROWS,
		);
		for (const [index, el] of mounted) {
			if (index >= first && index <= last) continue;
			// Unmounting the row a keyboard user is standing on drops focus to
			// the body. It stays until they move off it.
			if (el.contains(document.activeElement)) continue;
			el.remove();
			mounted.delete(index);
		}
		for (let index = first; index <= last; index++) {
			if (mounted.has(index)) continue;
			const el = renderRow(index);
			el.style.top = `${index * pitch}px`;
			mounted.set(index, el);
		}
		if (measured) return;
		// A view laid out while hidden reads every height as zero: the first row that reports one settles the pitch,
		// and everything placed against the fallback has to move.
		const sample = mounted.get(first)?.getBoundingClientRect().height ?? 0;
		if (sample <= 0) return;
		pitch = sample + rowGap(container);
		measured = true;
		applyPitch(container, pitch, true);
		remount();
		update();
	};

	const schedule = (): void => {
		if (frame) return;
		frame = window.requestAnimationFrame(update);
	};

	scroller.addEventListener("scroll", schedule, { passive: true });
	const resize = new ResizeObserver(schedule);
	resize.observe(scroller);
	container.style.height = `${count * pitch}px`;
	update();

	return {
		/**
		 * Synchronous: callers are points where the pane just moved, and waiting a frame would show rows
		 * for the old position.
		 */
		refresh(): void {
			if (frame) window.cancelAnimationFrame(frame);
			frame = 0;
			update();
		},
		setCount(next: number): void {
			count = next;
			remount();
			update();
		},
		destroy(): void {
			if (frame) window.cancelAnimationFrame(frame);
			scroller.removeEventListener("scroll", schedule);
			resize.disconnect();
			container.removeClass("is-virtual");
			container.style.removeProperty("height");
			container.style.removeProperty("--obsync-row-height");
		},
	};
}

/**
 * The first two rows, since a tree interleaves folders and files styled apart. Zero means the view is not
 * visible yet.
 */
function measureRows(
	container: HTMLElement,
	renderRow: (index: number) => HTMLElement,
	count: number,
): number {
	let height = 0;
	for (let index = 0; index < Math.min(2, count); index++) {
		const probe = renderRow(index);
		height = Math.max(height, probe.getBoundingClientRect().height);
		probe.remove();
	}
	return height > 0 ? height + rowGap(container) : 0;
}

/** Rows are pinned to the measured height: a pitch only holds while all share one, and padding alone drifts 2 px. */
function applyPitch(
	container: HTMLElement,
	pitch: number,
	measured: boolean,
): void {
	if (!measured) return;
	const gap = rowGap(container);
	container.style.setProperty("--obsync-row-height", `${pitch - gap}px`);
}

/** The gap the flow layout would have put between rows, kept in the pitch. */
function rowGap(container: HTMLElement): number {
	const gap = Number.parseFloat(getComputedStyle(container).rowGap);
	return Number.isFinite(gap) ? gap : 0;
}
