import { Notice, Platform } from "obsidian";
import {
	type ActivityCalendar,
	bandsOf,
	type CalendarDay,
	dayTooltip,
	RESOLUTION_TEXT,
} from "./calendar";

/** Narrower bands leave their label out. */
const LABELED_WEEKS = 4;
const TIP_MS = 4000;
/** Cells run day by day, a week per column. */
const KEY_STEPS: Record<string, number> = {
	ArrowUp: -1,
	ArrowDown: 1,
	ArrowLeft: -7,
	ArrowRight: 7,
};

export interface CalendarOptions {
	/** Start of the day drawn ringed. */
	picked?: number | null;
	onPick?: (day: CalendarDay) => void;
}

/** Weeks as columns, scrolled to the picked day or today; the strip under them says how each stretch is kept. */
export function renderActivityCalendar(
	parent: HTMLElement,
	calendar: ActivityCalendar,
	{ picked = null, onPick }: CalendarOptions = {},
): void {
	const scroller = parent.createDiv({ cls: "mdsync-calendar" });
	const months = scroller.createDiv({ cls: "mdsync-calendar-months" });
	const grid = scroller.createDiv({ cls: "mdsync-calendar-grid" });
	const days = new Map<string, CalendarDay>();
	const cells: HTMLElement[] = [];
	for (const week of calendar.weeks) {
		months.createSpan({ cls: "mdsync-calendar-month", text: week.month ?? "" });
		const column = grid.createDiv({ cls: "mdsync-calendar-week" });
		for (const day of week.days) {
			const key = String(day.start);
			days.set(key, day);
			const cell = column.createDiv({
				cls: `mdsync-calendar-day is-level-${day.level}`,
				attr: { "aria-label": dayTooltip(day), "data-day": key },
			});
			cell.toggleClass("is-counts", day.res === "counts");
			cell.toggleClass("is-picked", day.start === picked);
			cells.push(cell);
		}
	}
	const strip = scroller.createDiv({ cls: "mdsync-calendar-bands" });
	for (const band of bandsOf(calendar.weeks)) {
		const el = strip.createDiv({
			cls: "mdsync-calendar-band",
			attr: { "data-res": band.res ?? "none" },
		});
		el.style.setProperty("--mdsync-weeks", String(band.weeks));
		if (band.res && band.weeks >= LABELED_WEEKS)
			el.createSpan({ text: RESOLUTION_TEXT[band.res] });
	}
	const ringed = grid.querySelector<HTMLElement>(".is-picked");
	let tip: Notice | null = null;
	const pick = (cell: HTMLElement): void => {
		const day = days.get(cell.dataset.day ?? "");
		if (!day) return;
		// A phone has no hover to show the tooltip.
		if (Platform.isMobile) {
			tip?.hide();
			tip = new Notice(cell.getAttribute("aria-label") ?? "", TIP_MS);
		}
		onPick?.(day);
	};
	grid.addEventListener("click", (event) => {
		const cell =
			event.target instanceof Element
				? event.target.closest<HTMLElement>("[data-day]")
				: null;
		if (cell) pick(cell);
	});
	if (onPick) makeRoving(grid, cells, ringed ?? cells[cells.length - 1], pick);
	requestAnimationFrame(() => {
		scroller.scrollLeft = ringed
			? ringed.offsetLeft - scroller.clientWidth / 2
			: scroller.scrollWidth;
	});
}

/** One tab stop for the whole grid; arrows move a day or a week, Enter or Space picks. */
function makeRoving(
	grid: HTMLElement,
	cells: readonly HTMLElement[],
	start: HTMLElement | undefined,
	pick: (cell: HTMLElement) => void,
): void {
	grid.addClass("is-pickable");
	for (const cell of cells) {
		cell.setAttr("role", "button");
		cell.tabIndex = cell === start ? 0 : -1;
		cell.setAttr("aria-pressed", String(cell.hasClass("is-picked")));
	}
	grid.addEventListener("keydown", (event) => {
		const index = cells.indexOf(event.target as HTMLElement);
		const cell = cells[index];
		if (!cell) return;
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			pick(cell);
			return;
		}
		const next = cells[index + (KEY_STEPS[event.key] ?? Number.NaN)];
		if (!next) return;
		event.preventDefault();
		cell.tabIndex = -1;
		next.tabIndex = 0;
		next.focus();
	});
}
