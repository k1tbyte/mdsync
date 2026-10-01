import type { EditorView } from "@codemirror/view";
import type { Span } from "@/sync/merge-model";
import { firstIndex } from "@/utils";
import { docBottom, spanBounds } from "./geometry";

/** IntelliJ keeps the line a third of the way down the viewport aligned. */
const ANCHOR_RATIO = 1 / 3;

/** [y in `a`, y in `b`] in each document's own pixel space. */
export type ScrollPair = readonly [number, number];

/** Anchor pairs sorted on both coordinates, read by index so a scroll measures only the few it visits. */
export interface ScrollAnchors {
	readonly length: number;
	at(index: number): ScrollPair | undefined;
}

/** Both tops only, for panes that are not mounted yet. */
export const NO_ANCHORS: readonly ScrollPair[] = [[0, 0]];

/** One correspondence between two panes. */
export interface ScrollLink {
	a: EditorView;
	b: EditorView;
	pairs(): ScrollAnchors;
}

/** Anchors of paired spans, measured on demand: document tops, each pair's top and bottom, then document ends. */
export function spanAnchors(
	a: EditorView,
	b: EditorView,
	count: number,
	spans: (index: number) => readonly [Span, Span],
): ScrollAnchors {
	const length = count * 2 + 2;
	return {
		length,
		at(index) {
			if (index >= length) return undefined;
			if (index === 0) return [0, 0];
			if (index === length - 1) return [docBottom(a), docBottom(b)];
			const [spanA, spanB] = spans((index - 1) >> 1);
			const boundsA = spanBounds(a, spanA);
			const boundsB = spanBounds(b, spanB);
			return index % 2 === 1
				? [boundsA.top, boundsB.top]
				: [boundsA.bottom, boundsB.bottom];
		},
	};
}

/** Soft scroll sync over pane links: each change's top and bottom anchor an interpolation, propagated breadth-first. */
export class PaneScrollSync {
	private readonly expected = new Map<EditorView, number>();
	private readonly detach: Array<() => void> = [];

	constructor(
		private readonly links: readonly ScrollLink[],
		private readonly onScroll: () => void,
	) {
		const views = new Set<EditorView>();
		for (const link of links) {
			views.add(link.a);
			views.add(link.b);
		}
		for (const view of views) {
			const handler = (): void => this.handle(view);
			view.scrollDOM.addEventListener("scroll", handler, { passive: true });
			this.detach.push(() =>
				view.scrollDOM.removeEventListener("scroll", handler),
			);
		}
	}

	/** Scroll `view` so `docY` sits at the anchor line; linked panes follow. */
	revealIn(view: EditorView, docY: number): void {
		this.scrollTo(view, docY);
		this.follow(view, docY, null);
		this.onScroll();
	}

	destroy(): void {
		for (const off of this.detach) off();
		this.detach.length = 0;
	}

	private handle(master: EditorView): void {
		// A scroll this class caused arrives later as an event; only the user's own count.
		const own = this.expected.get(master);
		this.expected.delete(master);
		if (own === undefined || Math.abs(master.scrollDOM.scrollTop - own) >= 1) {
			this.follow(master, anchorOf(master));
		}
		this.onScroll();
	}

	private follow(
		master: EditorView,
		masterY: number,
		edge: Edge = edgeOf(master),
	): void {
		const visited = new Set<EditorView>([master]);
		const queue: Array<[EditorView, number]> = [[master, masterY]];
		for (let head = 0; head < queue.length; head++) {
			const [view, y] = queue[head] as [EditorView, number];
			for (const link of this.links) {
				let target: EditorView;
				let targetY: number;
				if (link.a === view) {
					target = link.b;
					targetY = transfer(link.pairs(), y, false);
				} else if (link.b === view) {
					target = link.a;
					targetY = transfer(link.pairs(), y, true);
				} else {
					continue;
				}
				if (visited.has(target)) continue;
				visited.add(target);
				this.scrollTo(target, targetY, edge);
				queue.push([target, targetY]);
			}
		}
	}

	private scrollTo(view: EditorView, anchorY: number, edge: Edge = null): void {
		const el = view.scrollDOM;
		let target = Math.max(
			0,
			anchorY + view.documentPadding.top - el.clientHeight * ANCHOR_RATIO,
		);
		if (edge === "top") target = 0;
		else if (edge === "bottom") target = el.scrollHeight - el.clientHeight;
		if (Math.abs(el.scrollTop - target) < 1) return;
		el.scrollTop = target;
		this.expected.set(view, el.scrollTop);
	}
}

type Edge = "top" | "bottom" | null;

/** At either end a pane cannot go further, so the panes line up on the end itself rather than via the anchors. */
function edgeOf(view: EditorView): Edge {
	const el = view.scrollDOM;
	if (el.scrollTop <= 0) return "top";
	if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return "bottom";
	return null;
}

/** Piecewise-linear map of `y` across the anchors; `reverse` reads b→a. */
function transfer(pairs: ScrollAnchors, y: number, reverse: boolean): number {
	const from = reverse ? 1 : 0;
	const to = reverse ? 0 : 1;
	const above = firstIndex(
		pairs.length,
		(index) => (pairs.at(index)?.[from] ?? 0) > y,
	);
	const i = Math.max(0, above - 1);
	const a = pairs.at(i);
	const b = pairs.at(i + 1);
	if (!a) return y;
	if (!b) return a[to] + (y - a[from]);
	const length = b[from] - a[from];
	const t = length <= 0 ? 1 : (y - a[from]) / length;
	return a[to] + t * (b[to] - a[to]);
}

function anchorOf(view: EditorView): number {
	const el = view.scrollDOM;
	return (
		el.scrollTop - view.documentPadding.top + el.clientHeight * ANCHOR_RATIO
	);
}
