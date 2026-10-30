import { SearchComponent, setIcon } from "obsidian";
import { formatDay, pluralize, startOfDay } from "@/core/shared";
import {
	appendIconButton,
	appendLabeledButton,
	callout,
	makeActivatable,
	notifyError,
} from "@/core/ui";
import type { HistoryDiffTarget } from "@/features/diff";
import {
	type ActivityCalendar,
	buildCalendar,
	type CalendarDay,
	renderActivityCalendar,
	type SnapshotListResult,
} from "@/features/sync";
import { ageTitle, groupByAge, inLastHour } from "../history/age-groups";
import { HistoryList } from "../history/history-list";
import { RowPager } from "../history/row-pager";
import type { SourceControlHost } from "../host";
import { renderAgeHeader } from "../row-parts";
import {
	renderEmptyState,
	renderHistoryOff,
	renderLoadError,
	renderLoading,
} from "../tab-states";
import { type CardContext, renderSessionCard } from "./session-card";
import { buildSessionRows, type SessionRow, touches } from "./session-rows";
import { TimelineActions } from "./timeline-actions";
import { type TimelineFileRow, timelineDiffTarget } from "./timeline-rows";

export class TimelineTab {
	private readonly snapshots = new HistoryList<SnapshotListResult>(() => {
		const loaded = this.snapshots.value;
		if (loaded) this.prune(loaded);
		this.onRerender();
	});
	private openGeneration = 0;
	private readonly open = new Set<string>();
	private readonly pages = new Map<string, RowPager>();
	/** Rows survive UI-only rerenders, so composed changes keep the identity the file-row cache is keyed by. */
	private sessionMemo: {
		snapshots: SnapshotListResult["snapshots"];
		key: string;
		rows: SessionRow[];
	} | null = null;
	/** The calendar scans every snapshot per day, so UI-only rerenders reuse it until the result or the day changes. */
	private calendarMemo: {
		result: SnapshotListResult;
		today: number;
		calendar: ActivityCalendar;
	} | null = null;
	private query = "";
	private sessionPager = new RowPager();
	/** What the session pager counts pages of: another result, filter or day starts it over. */
	private pagedFor: {
		result: SnapshotListResult;
		query: string;
		day: number | null;
	} | null = null;
	private picked: CalendarDay | null = null;
	private activityOpen = true;
	private selected: string | null = null;
	private opening: string | null = null;
	private list: HTMLElement | null = null;
	/** Typing redraws only the list, so the filter keeps its focus and an IME its composition. */
	private redrawSessions: () => void = () => {};
	private scrollTop = 0;
	private focusKey: string | null = null;
	private readonly actions: TimelineActions;

	constructor(
		private readonly plugin: SourceControlHost,
		private readonly onRerender: () => void,
		private readonly openDiff: (
			path: string,
			history: HistoryDiffTarget,
		) => Promise<void>,
		onSnapshotsChanged: () => void,
	) {
		this.actions = new TimelineActions(
			plugin,
			onSnapshotsChanged,
			(owner, file, mode) => void this.openFile(owner, file, mode),
		);
	}

	captureState(): void {
		if (
			!this.list?.isConnected ||
			this.list.hasClass("is-loading") ||
			!this.snapshots.value
		)
			return;
		this.scrollTop = this.list.scrollTop;
		const active = this.list.ownerDocument.activeElement;
		this.focusKey =
			active && this.list.contains(active)
				? active.getAttribute("data-timeline-focus")
				: null;
	}

	clear(): void {
		this.captureState();
		this.snapshots.clear();
	}

	clearOffline(): boolean {
		if (!this.snapshots.offline) return false;
		this.clear();
		return true;
	}

	dispose(): void {
		this.snapshots.clear();
		this.openGeneration++;
		this.list = null;
		this.redrawSessions = () => {};
	}

	render(parent: HTMLElement, tools: HTMLElement): void {
		const pane = parent.createDiv({
			cls: "mdsync-history-pane mdsync-timeline",
		});
		if (!this.plugin.settings.fileHistoryEnabled) {
			renderHistoryOff(
				pane,
				this.plugin.app,
				"History is off. Turn on History in MDSync settings to see the timeline.",
			);
			return;
		}
		appendIconButton(tools, "refresh-cw", "Refresh timeline", () =>
			this.reload(),
		);
		this.list = pane.createDiv({
			cls: "mdsync-history-list mdsync-timeline-list",
		});
		this.list.toggleClass("is-loading", this.snapshots.value === null);
		this.renderBody(this.list);
		if (!this.snapshots.value) return;
		this.list.scrollTop = this.scrollTop;
		if (this.focusKey) {
			const target = Array.from(
				this.list.querySelectorAll<HTMLElement>("[data-timeline-focus]"),
			).find((el) => el.getAttribute("data-timeline-focus") === this.focusKey);
			target?.focus({ preventScroll: true });
			this.focusKey = null;
		}
	}

	private reload(): void {
		this.clear();
		this.onRerender();
	}

	private renderBody(body: HTMLElement): void {
		const { value: result, error } = this.snapshots;
		if (error) {
			renderLoadError(body, "Could not load the timeline", error, () =>
				this.reload(),
			);
			return;
		}
		if (!result) {
			renderLoading(body);
			this.snapshots.load(() => this.plugin.controller.history.listSnapshots());
			return;
		}
		if (result.lagging) {
			callout(
				body,
				"warning",
				"History has not caught up with the latest push yet, so the newest version is missing.",
			);
		}
		const rows = this.sessionRows(result);
		// A packed version whose changes cancel out is no row, yet its pushes are activity.
		const empty = rows.length === 0 && !Object.keys(result.activity).length;
		if (empty && !result.lagging) {
			renderEmptyState(body, {
				icon: "clock-3",
				title: "No pushes yet",
				text: "No pushes recorded yet. The timeline fills up as you push.",
			});
			return;
		}
		// Built while hidden too: a day picked in settings filters by it.
		const calendar = this.calendarOf(result);
		// A reload may have thinned the picked day, or moved it off the calendar.
		const picked = this.picked?.start;
		this.picked =
			calendar.weeks
				.flatMap((week) => week.days)
				.find((day) => day.start === picked) ?? null;
		if (this.plugin.settings.fileHistoryActivity)
			this.renderActivity(body, calendar);
		this.renderFilter(body);
		const sessions = body.createDiv({ cls: "mdsync-timeline-sessions" });
		this.redrawSessions = () => {
			sessions.empty();
			this.renderSessions(sessions, rows, result, calendar);
		};
		this.redrawSessions();
	}

	private calendarOf(result: SnapshotListResult): ActivityCalendar {
		const today = startOfDay(Date.now());
		if (
			this.calendarMemo?.result !== result ||
			this.calendarMemo.today !== today
		)
			this.calendarMemo = {
				result,
				today,
				calendar: buildCalendar(result.activity, result.snapshots),
			};
		return this.calendarMemo.calendar;
	}

	private sessionRows({ snapshots }: SnapshotListResult): SessionRow[] {
		const currentDevice = this.plugin.controller.currentDevice();
		const now = Date.now();
		// Sessions and titles read the clock: the minute, and each push's own hour mark.
		const key = JSON.stringify([
			Math.floor(now / 60_000),
			snapshots.filter(({ at }) => inLastHour(at, now)).length,
			currentDevice.id,
			currentDevice.name,
		]);
		if (
			this.sessionMemo?.snapshots !== snapshots ||
			this.sessionMemo.key !== key
		)
			this.sessionMemo = {
				snapshots,
				key,
				rows: buildSessionRows(snapshots, { currentDevice }),
			};
		return this.sessionMemo.rows;
	}

	private renderActivity(body: HTMLElement, calendar: ActivityCalendar): void {
		const card = body.createDiv({ cls: "mdsync-timeline-activity" });
		const head = card.createDiv({ cls: "mdsync-timeline-activity-head" });
		head.setAttr("aria-expanded", String(this.activityOpen));
		head.setAttr("data-timeline-focus", "activity");
		makeActivatable(head, "Activity", () => {
			this.activityOpen = !this.activityOpen;
			this.onRerender();
		});
		setIcon(
			head.createSpan({ cls: "mdsync-timeline-icon" }),
			this.activityOpen ? "chevron-down" : "chevron-right",
		);
		head.createSpan({
			cls: "mdsync-timeline-activity-title",
			text: "Activity",
		});
		head.createSpan({
			cls: "mdsync-timeline-activity-sum",
			text: `${pluralize(calendar.pushes, "push", "pushes")} since ${formatDay(calendar.since, Date.now(), false)}`,
		});
		if (!this.activityOpen) return;
		renderActivityCalendar(card, calendar, {
			picked: this.picked?.start ?? null,
			onPick: (day) => {
				this.picked = this.picked?.start === day.start ? null : day;
				this.onRerender();
			},
		});
		// A pick redraws the pane; the focus follows the day.
		card.querySelectorAll<HTMLElement>("[data-day]").forEach((cell) => {
			cell.setAttr("data-timeline-focus", `day:${cell.dataset.day}`);
		});
	}

	private renderFilter(body: HTMLElement): void {
		const bar = body.createDiv({ cls: "mdsync-timeline-filter" });
		const search = new SearchComponent(bar)
			.setPlaceholder("Filter by path or folder")
			.setValue(this.query);
		search.inputEl.setAttr("aria-label", "Filter pushes by path");
		search.inputEl.setAttr("data-timeline-focus", "filter");
		search.onChange((value) => {
			this.query = value;
			this.redrawSessions();
		});
		if (!this.picked) return;
		const chip = bar.createSpan({ cls: "mdsync-timeline-day-chip" });
		chip.createSpan({ text: formatDay(this.picked.start) });
		appendIconButton(chip, "x", "Show every day", () => {
			this.picked = null;
			this.onRerender();
		});
	}

	private renderSessions(
		el: HTMLElement,
		rows: readonly SessionRow[],
		result: SnapshotListResult,
		calendar: ActivityCalendar,
	): void {
		const picked = this.picked;
		const query = this.query.trim().toLowerCase();
		const pager = this.pagerFor(result, query, picked?.start ?? null);
		if (picked?.res === "counts") {
			this.renderCountsDay(el, picked, result, calendar);
			return;
		}
		const day = picked && new Date(picked.start);
		// From the date, never by adding a day to the start: a DST switch can skip the midnight.
		const dayEnd =
			day && new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
		const shown = rows.filter(
			(row) =>
				(!query || row.versions.some((version) => touches(version, query))) &&
				(!dayEnd || row.firstAt < dayEnd.getTime()),
		);
		if (shown.length === 0 && query) {
			renderEmptyState(el, {
				icon: "search-x",
				tone: "muted",
				title: `No pushes touch ${this.query.trim()}`,
				text: result.truncated
					? "Nothing under this path changed in the history that can be read."
					: "Nothing under this path changed in the kept history.",
				action: { text: "Clear filter", run: () => this.clearQuery() },
			});
		}
		const ctx = this.cardContext(query);
		// Pinned lead, as groupByAge orders them, so a page break never splits the pinned group.
		const ordered = [
			...shown.filter((row) => row.pinned),
			...shown.filter((row) => !row.pinned),
		];
		for (const group of groupByAge(pager.slice(ordered))) {
			renderAgeHeader(el, group);
			for (const row of group.rows) renderSessionCard(el, row, ctx);
		}
		pager.render(el, ordered.length, () => {
			this.redrawSessions();
			// The button sat at the foot of the old page; the next one reads from its top.
			el.scrollIntoView({ block: "start" });
		});
		if (result.truncated)
			callout(
				el,
				"warning",
				"A push record is missing, so the versions before it are hidden.",
				"Older history is out of reach",
			);
	}

	private pagerFor(
		result: SnapshotListResult,
		query: string,
		day: number | null,
	): RowPager {
		const paged = this.pagedFor;
		if (
			paged?.result !== result ||
			paged.query !== query ||
			paged.day !== day
		) {
			this.sessionPager = new RowPager();
			this.pagedFor = { result, query, day };
		}
		return this.sessionPager;
	}

	/** Past the horizon a day kept only its counts; the nearest version is the oldest still walked. */
	private renderCountsDay(
		el: HTMLElement,
		day: CalendarDay,
		result: SnapshotListResult,
		calendar: ActivityCalendar,
	): void {
		const card = el.createDiv({ cls: "mdsync-timeline-counts" });
		const title = card.createDiv({ cls: "mdsync-timeline-counts-title" });
		setIcon(title.createSpan(), "bar-chart-2");
		title.createSpan({
			text: `${formatDay(day.start)}: ${pluralize(day.pushes, "push", "pushes")}`,
		});
		const nearest = result.snapshots.filter((version) => version.res).pop();
		card.createDiv({
			cls: "mdsync-history-row-meta",
			text: nearest
				? `Only counts are kept for this day. The nearest version is from ${ageTitle(nearest)}.`
				: "Only counts are kept for this day.",
		});
		const start = nearest && startOfDay(nearest.at);
		const target = calendar.weeks
			.flatMap((week) => week.days)
			.find((candidate) => candidate.start === start);
		if (!target) return;
		appendLabeledButton(card, "arrow-right", "Show nearest version", () => {
			this.picked = target;
			this.onRerender();
		});
	}

	/** Fresh history from the top; the day is rebound to the calendar's own once it loads. */
	showDay(start: number): void {
		this.snapshots.clear();
		this.picked = { start, pushes: 0, level: 0, res: null };
		this.query = "";
		this.scrollTop = 0;
		this.focusKey = null;
	}

	private clearQuery(): void {
		this.query = "";
		this.onRerender();
	}

	private cardContext(query: string): CardContext {
		return {
			query,
			selected: this.selected,
			opening: this.opening,
			isOpen: (key) => this.open.has(key),
			toggle: (key) => {
				if (!this.open.delete(key)) this.open.add(key);
				this.onRerender();
			},
			pager: (key) => {
				let pager = this.pages.get(key);
				if (!pager) {
					pager = new RowPager();
					this.pages.set(key, pager);
				}
				return pager;
			},
			rerender: this.onRerender,
			sessionMenu: (event, row) => this.actions.showSessionMenu(event, row),
			versionMenu: (event, row) => this.actions.showVersionMenu(event, row),
			fileMenu: (event, owner, file) =>
				this.actions.showFileMenu(event, owner, file),
			openFile: (owner, file) => void this.openFile(owner, file),
		};
	}

	/** Rows gone from the new list take their open state with them. */
	private prune({ snapshots }: SnapshotListResult): void {
		const ids = new Set(snapshots.map((row) => row.id));
		// Keys are an id, or an id after a "v:", "all:" or "versions:" prefix.
		const live = (key: string) => ids.has(key.slice(key.indexOf(":") + 1));
		for (const key of this.open) if (!live(key)) this.open.delete(key);
		for (const key of this.pages.keys()) if (!live(key)) this.pages.delete(key);
	}

	private async openFile(
		owner: string,
		file: TimelineFileRow,
		mode: "current" | "change" = "current",
	): Promise<void> {
		const generation = ++this.openGeneration;
		this.selected = JSON.stringify([owner, file.path]);
		this.opening = this.selected;
		this.onRerender();
		try {
			await this.openDiff(file.path, timelineDiffTarget(file, mode));
		} catch (error) {
			if (generation === this.openGeneration)
				notifyError("Could not open historical file", error);
		} finally {
			if (generation === this.openGeneration) {
				this.opening = null;
				this.onRerender();
			}
		}
	}
}
