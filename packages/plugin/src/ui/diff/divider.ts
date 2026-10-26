import type { EditorView } from "@codemirror/view";
import type { Span } from "@/sync/merge-model";
import { firstIndex } from "@/utils";
import { type Bounds, shiftBounds, spanBounds } from "./geometry";
import { type RailAction, renderRailButton } from "./rail";

/** One change as the strip sees it: where it sits in each pane, how to draw it, what it offers. */
export interface DividerItem {
	key: number;
	/** Span in the pane the buttons belong to. */
	near: Span;
	/** Span in the pane across the strip. */
	far: Span;
	/** CSS tone whose `--mdsync-tone-<tone>` colours the connector. */
	tone: string;
	actions: RailAction[];
	/** Keeps its buttons on the strip while another change is selected. */
	pinned?: boolean;
}

/** An unchanged run folded in both panes. */
export interface DividerBand {
	near: Span;
	far: Span;
}

interface Placed<T> {
	item: T;
	near: Bounds;
	far: Bounds;
}

/** How far along the divider the curve's control points sit, as in IntelliJ. */
const CURVE = 0.3;
/** Space kept between one change's buttons and the next change's. */
const GROUP_GAP = 2;

interface ActionGroup {
	el: HTMLElement;
	/** What the buttons show; they are rebuilt only when it changes. */
	signature: string;
	/** As last laid out; the buttons call through it, so a refresh needs no rebuild. */
	item: DividerItem;
}

/**
 * Filled connectors joining a change to where it lands on the far side; the selected and pinned changes
 * show their action buttons on their connectors. Only changes on screen are drawn.
 */
export class Divider {
	private readonly canvas: HTMLCanvasElement;
	private readonly actions: HTMLElement;
	private readonly groups = new Map<number, ActionGroup>();
	private readonly listeners = new AbortController();
	private items: readonly DividerItem[] = [];
	private bands: readonly DividerBand[] = [];
	private placed: readonly Placed<DividerItem>[] = [];
	private selected: number | null = null;
	private hovered: number | null = null;
	private groupHeight = 0;
	private size = { width: 0, height: 0, dpr: 0 };

	constructor(
		private readonly el: HTMLElement,
		private readonly nearView: EditorView,
		private readonly farView: EditorView,
		private readonly nearEdge: "left" | "right",
		private readonly onSelect?: (key: number | null) => void,
	) {
		this.canvas = el.createEl("canvas", { cls: "mdsync-divider-canvas" });
		this.actions = el.createDiv({ cls: "mdsync-divider-actions" });
		const { signal } = this.listeners;
		el.addEventListener(
			"wheel",
			(event) => {
				farView.scrollDOM.scrollTop += event.deltaY;
			},
			{ passive: true, signal },
		);
		this.canvas.addEventListener(
			"click",
			(event) => {
				const key = this.hitTest(event)?.key ?? null;
				this.select(key);
				this.onSelect?.(key);
			},
			{ signal },
		);
		this.canvas.addEventListener(
			"pointermove",
			(event) => this.setHovered(this.hitTest(event)?.key ?? null),
			{ signal },
		);
		this.canvas.addEventListener("pointerleave", () => this.setHovered(null), {
			signal,
		});
	}

	update(
		items: readonly DividerItem[],
		bands: readonly DividerBand[] = [],
	): void {
		this.items = items;
		this.bands = bands;
		if (!items.some((item) => item.key === this.selected)) this.selected = null;
		this.layout();
	}

	/** Shows a change's buttons; null hides them. */
	select(key: number | null): void {
		if (this.selected === key) return;
		this.selected = key;
		this.layout();
	}

	destroy(): void {
		this.listeners.abort();
		this.groups.clear();
		this.el.empty();
	}

	layout(): void {
		const rect = this.el.getBoundingClientRect();
		// Hidden (inline layout): nothing to measure or place.
		if (rect.width === 0 || rect.height === 0) return;
		this.placed = this.visible(this.items, rect);
		this.draw(rect, this.visible(this.bands, rect));
		this.placeGroups(rect);
	}

	private setHovered(key: number | null): void {
		this.canvas.toggleClass("has-target", key !== null);
		if (this.hovered === key) return;
		this.hovered = key;
		this.layout();
	}

	private draw(rect: DOMRect, bands: readonly Placed<DividerBand>[]): void {
		const { width, height } = rect;
		const ctx = this.prepareCanvas(width, height);
		if (!ctx) return;
		const style = getComputedStyle(this.el);
		// The strip already has the folded bars' colour: their borders crossing it make one bar.
		ctx.strokeStyle = style.getPropertyValue("--background-modifier-border");
		ctx.lineWidth = 1;
		for (const { near, far } of bands) {
			ctx.stroke(this.edgePath(width, near.top + 0.5, far.top + 0.5));
			ctx.stroke(this.edgePath(width, near.bottom - 0.5, far.bottom - 0.5));
		}
		for (const { item, near, far } of this.placed) {
			// Colour is the change's kind alone; a click or a choice must not recolour it.
			ctx.fillStyle = `rgb(${style.getPropertyValue(`--mdsync-tone-${item.tone}`).trim()})`;
			const raised = item.key === this.hovered || item.key === this.selected;
			const base =
				item.tone === "added" || item.tone === "removed" ? 0.12 : 0.16;
			ctx.globalAlpha = raised ? 0.32 : base;
			ctx.fill(this.connectorPath(width, near, far));
		}
		ctx.globalAlpha = 1;
	}

	/** On each connector's middle band, mid-strip, below the previous change's buttons, inside the strip. */
	private placeGroups(rect: DOMRect): void {
		const shown = new Set<number>();
		let floor = 0;
		for (const { item, near, far } of this.placed) {
			const selected = item.key === this.selected;
			if (item.actions.length === 0 || !(selected || item.pinned)) continue;
			const group = this.groupFor(item);
			this.groupHeight ||= group.el.offsetHeight;
			const height = this.groupHeight;
			const middle =
				(near.top + far.top + near.bottom + far.bottom) / 4 - height / 2;
			// A crowded tail overlaps at the bottom rather than leave the strip; the selected one stays on top.
			const y = Math.min(Math.max(floor, middle, 0), rect.height - height);
			group.el.style.transform = `translate(-50%, ${Math.round(y)}px)`;
			group.el.toggleClass("is-selected", selected);
			floor = y + height + GROUP_GAP;
			shown.add(item.key);
		}
		for (const [key, group] of this.groups) {
			if (shown.has(key)) continue;
			group.el.remove();
			this.groups.delete(key);
		}
	}

	private groupFor(item: DividerItem): ActionGroup {
		let group = this.groups.get(item.key);
		if (!group) {
			const el = this.actions.createDiv({
				cls: "mdsync-divider-action",
				attr: {
					role: "group",
					"aria-label": `Actions for change ${item.key + 1}`,
				},
			});
			const { signal } = this.listeners;
			el.addEventListener("pointerenter", () => this.setHovered(item.key), {
				signal,
			});
			el.addEventListener("pointerleave", () => this.setHovered(null), {
				signal,
			});
			group = { el, signature: "", item };
			this.groups.set(item.key, group);
		}
		group.item = item;
		this.renderButtons(group);
		return group;
	}

	private renderButtons(group: ActionGroup): void {
		const signature = group.item.actions
			.map((action) => `${action.label}:${action.active}`)
			.join("|");
		if (signature === group.signature) return;
		const focused = [...group.el.children].indexOf(
			group.el.ownerDocument.activeElement as Element,
		);
		group.signature = signature;
		group.el.empty();
		const buttons = group.item.actions.map((action, index) =>
			renderRailButton(group.el, {
				...action,
				run: () => {
					// Selected first: a pinned group whose choice is undone stays, and keeps the keyboard.
					const { key } = group.item;
					this.select(key);
					this.onSelect?.(key);
					group.item.actions[index]?.run();
				},
			}),
		);
		// Pressing one rebuilds them all, maybe fewer; the keyboard stays in the group.
		if (focused >= 0) buttons[Math.min(focused, buttons.length - 1)]?.focus();
	}

	private hitTest(event: MouseEvent): DividerItem | undefined {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const actionable = this.placed.filter(
			({ item }) => item.actions.length > 0,
		);
		// Paths are in CSS pixels, the point too; the drawing scale would skew them apart.
		ctx.save();
		ctx.resetTransform();
		try {
			// Exact hits win before padding makes a squeezed neighbour clickable.
			for (const expand of [0, 3, 6]) {
				for (const { item, near, far } of actionable) {
					const path = this.connectorPath(rect.width, near, far, expand);
					if (ctx.isPointInPath(path, x, y)) return item;
				}
			}
			return undefined;
		} finally {
			ctx.restore();
		}
	}

	private visible<T extends DividerBand>(
		list: readonly T[],
		rect: DOMRect,
	): Placed<T>[] {
		const nearShift = this.nearView.documentTop - rect.top;
		const farShift = this.farView.documentTop - rect.top;
		const place = (item: T) => ({
			item,
			near: shiftBounds(spanBounds(this.nearView, item.near), nearShift),
			far: shiftBounds(spanBounds(this.farView, item.far), farShift),
		});
		const start = firstIndex(list.length, (index) => {
			const { near, far } = place(list[index] as T);
			return Math.max(near.bottom, far.bottom) >= 0;
		});
		const visible = [];
		for (let index = start; index < list.length; index++) {
			const placed = place(list[index] as T);
			if (Math.min(placed.near.top, placed.far.top) > rect.height) break;
			visible.push(placed);
		}
		return visible;
	}

	private connectorPath(
		width: number,
		near: Bounds,
		far: Bounds,
		expand = 0,
	): Path2D {
		const [x1, c1, c2, x2] = this.curveXs(width);
		const [nearTop, farTop] = [near.top - expand, far.top - expand];
		const [nearBottom, farBottom] = [near.bottom + expand, far.bottom + expand];
		const path = new Path2D();
		path.moveTo(x1, nearTop);
		path.bezierCurveTo(c1, nearTop, c2, farTop, x2, farTop);
		path.lineTo(x2, farBottom);
		path.bezierCurveTo(c2, farBottom, c1, nearBottom, x1, nearBottom);
		path.closePath();
		return path;
	}

	private edgePath(width: number, nearY: number, farY: number): Path2D {
		const [x1, c1, c2, x2] = this.curveXs(width);
		const path = new Path2D();
		path.moveTo(x1, nearY);
		path.bezierCurveTo(c1, nearY, c2, farY, x2, farY);
		return path;
	}

	/** The near end, both control points and the far end along the strip. */
	private curveXs(width: number): [number, number, number, number] {
		const [x1, x2] = this.nearEdge === "left" ? [0, width] : [width, 0];
		return [x1, x1 + (x2 - x1) * CURVE, x2 - (x2 - x1) * CURVE, x2];
	}

	private prepareCanvas(
		width: number,
		height: number,
	): CanvasRenderingContext2D | null {
		if (width === 0 || height === 0) return null;
		const dpr = window.devicePixelRatio || 1;
		if (
			this.size.width !== width ||
			this.size.height !== height ||
			this.size.dpr !== dpr
		) {
			this.canvas.width = Math.round(width * dpr);
			this.canvas.height = Math.round(height * dpr);
			this.size = { width, height, dpr };
		}
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return null;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
		return ctx;
	}
}
