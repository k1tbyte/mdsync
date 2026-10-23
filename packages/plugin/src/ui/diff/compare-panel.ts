import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import { ChangeOverlay } from "./change-overlay";
import { choiceActions, type EChoiceKind, HunkChoices } from "./choices";
import { CompareControls, type CompareHosts } from "./compare-controls";
import {
	buildSegments,
	type CompareSegment,
	type CompareSide,
	compareState,
	segmentKind,
	segmentsChanged,
} from "./compare-decorations";
import { Divider, type DividerItem } from "./divider";
import { foldedBands } from "./gap-widgets";
import { sideSpan, spanBounds, updatePaneViewportWidth } from "./geometry";
import { LayoutMode } from "./layout-mode";
import {
	LineWrappingControl,
	type LineWrappingOptions,
} from "./line-wrapping-control";
import { setCombinedMode } from "./merge-decorations";
import { changeNavigation, type RailAction } from "./rail";
import {
	NO_ANCHORS,
	PaneScrollSync,
	type ScrollAnchors,
	spanAnchors,
} from "./scroll-sync";

export interface ComparePanelOptions extends LineWrappingOptions {
	direction: EDiffDirection;
	actionable: boolean;
	pinChosen: boolean;
	onPinChosenChange(enabled: boolean): void;
	onApply(choices: HunkChoices): void;
}

export function renderTextDiff(
	parent: HTMLElement,
	model: FileDiffModel,
	options: ComparePanelOptions,
): ComparePanel | null {
	if (model.hunks.hunks.length === 0) {
		parent.createDiv({
			cls: "mdsync-diff-empty",
			text:
				model.movedFrom === undefined
					? "No textual differences."
					: `Moved from ${model.movedFrom}, unchanged.`,
		});
		return null;
	}
	const panel = new ComparePanel(options);
	panel.render(parent, model);
	return panel;
}

/**
 * Two read-only panes and a divider, or one combined pane when narrow. A rail click only picks; Apply
 * carries all picks out.
 */
export class ComparePanel {
	private readonly choices = new HunkChoices();
	/** Keys of the segments folded to one row in both panes. */
	private readonly folded = new Set<number>();
	/** Unchanged runs opened in both panes, by index. */
	private readonly opened = new Set<number>();
	private segments: readonly CompareSegment[] = [];
	private model: FileDiffModel | null = null;
	private rootEl: HTMLElement | null = null;
	private leftView: EditorView | null = null;
	private rightView: EditorView | null = null;
	private divider: Divider | null = null;
	private overlays: ChangeOverlay[] = [];
	private scrollSync: PaneScrollSync | null = null;
	private layoutMode: LayoutMode | null = null;
	private controls: CompareControls | null = null;
	private layoutFrame: number | null = null;
	private readonly wrapping: LineWrappingControl;
	private pinChosen: boolean;
	private current = -1;

	constructor(private readonly options: ComparePanelOptions) {
		this.pinChosen = options.pinChosen;
		this.wrapping = new LineWrappingControl(
			options,
			() => [this.leftView, this.rightView],
			() => this.scheduleLayout(),
		);
	}

	render(parent: HTMLElement, model: FileDiffModel): void {
		this.model = model;
		this.segments = buildSegments(model);
		const root = parent.createDiv({ cls: "mdsync-compare-panel" });
		this.rootEl = root;
		this.renderToolbar(root);
		const [first, second] = this.paneOrder();
		const heads = root.createDiv({ cls: "mdsync-compare-heads" });
		const body = root.createDiv({ cls: "mdsync-compare-body" });
		const firstView = this.renderPane(heads, body, model, first, true);
		heads.createDiv({ cls: "mdsync-compare-divider-head" });
		const dividerEl = body.createDiv({ cls: "mdsync-compare-divider" });
		const secondView = this.renderPane(heads, body, model, second, false);
		const views: Record<CompareSide, EditorView> =
			first === "left"
				? { left: firstView, right: secondView }
				: { left: secondView, right: firstView };
		this.leftView = views.left;
		this.rightView = views.right;
		const near = this.nearSide();
		this.divider = new Divider(
			dividerEl,
			views[near],
			views[near === "left" ? "right" : "left"],
			near === first ? "left" : "right",
			(key) =>
				this.selectSegment(
					this.segments.findIndex((segment) => segment.key === key),
				),
		);
		this.scrollSync = new PaneScrollSync(
			[{ a: views.left, b: views.right, pairs: () => this.scrollPairs() }],
			() => this.scheduleLayout(),
		);
		this.refreshDivider();
		this.layoutMode?.refresh();
		this.updateToolbar();
		this.scheduleLayout();
	}

	/** False asks the owner to rebuild the panel and its surrounding explanation. */
	update(model: FileDiffModel, actionable: boolean): boolean {
		const previous = this.model;
		const root = this.rootEl;
		if (!previous || !root) return false;
		const structural =
			model.direction !== previous.direction ||
			model.leftLabel !== previous.leftLabel ||
			model.rightLabel !== previous.rightLabel ||
			actionable !== this.options.actionable;
		if (structural) return false;
		this.model = model;
		if (
			model.leftHash === previous.leftHash &&
			model.rightHash === previous.rightHash
		) {
			return true;
		}
		// The texts moved, so segment indices no longer address what the user saw.
		this.choices.clear();
		this.folded.clear();
		this.opened.clear();
		this.current = -1;
		this.divider?.select(null);
		this.segments = buildSegments(model);
		// A hash is of the exact text shown, so an unchanged side keeps its doc and scroll.
		if (model.leftHash !== previous.leftHash) {
			this.replaceDoc(this.leftView, model.leftText);
		}
		if (model.rightHash !== previous.rightHash) {
			this.replaceDoc(this.rightView, model.rightText);
		}
		this.redrawSegments();
		this.updateToolbar();
		this.scheduleLayout();
		return true;
	}

	destroy(): void {
		if (this.layoutFrame !== null) {
			window.cancelAnimationFrame(this.layoutFrame);
			this.layoutFrame = null;
		}
		this.layoutMode?.destroy();
		this.layoutMode = null;
		this.scrollSync?.destroy();
		this.scrollSync = null;
		this.divider?.destroy();
		this.divider = null;
		this.overlays = [];
		this.leftView?.destroy();
		this.rightView?.destroy();
		this.leftView = null;
		this.rightView = null;
		this.rootEl = null;
		this.controls?.info.remove();
		this.controls?.controls.remove();
		this.controls?.pending.remove();
		this.controls = null;
		this.current = -1;
		this.choices.clear();
		this.folded.clear();
		this.opened.clear();
	}

	mount(hosts: CompareHosts): void {
		this.controls?.mount(hosts);
		this.layoutMode?.refresh();
	}

	/** The pane the rail buttons belong to: the side a decision takes from. */
	private nearSide(): CompareSide {
		return this.options.direction === EDiffDirection.History ? "left" : "right";
	}

	/** Local sits on the left in every view, its own changes against the baseline included. */
	private paneOrder(): readonly [CompareSide, CompareSide] {
		return this.options.direction === EDiffDirection.Local
			? ["right", "left"]
			: ["left", "right"];
	}

	private renderPane(
		heads: HTMLElement,
		body: HTMLElement,
		model: FileDiffModel,
		side: CompareSide,
		first: boolean,
	): EditorView {
		heads.createDiv({
			cls: `mdsync-compare-head is-${side}`,
			text: side === "left" ? model.leftLabel : model.rightLabel,
		});
		const host = body.createDiv({
			cls: `mdsync-compare-host is-${side}${first ? " is-first" : ""}`,
		});
		const view = this.makeEditor(
			host,
			side === "left" ? model.leftText : model.rightText,
			side,
		);
		this.overlays.push(
			new ChangeOverlay(host, view, side, (key) =>
				this.toggle(this.folded, key),
			),
		);
		return view;
	}

	private makeEditor(
		parent: HTMLElement,
		doc: string,
		side: CompareSide,
	): EditorView {
		return new EditorView({
			state: EditorState.create({
				doc,
				extensions: [
					EditorState.readOnly.of(true),
					changeNavigation((delta) => this.jump(delta)),
					compareState({
						side,
						segments: () => this.segments,
						choices: this.choices,
						folded: () => this.folded,
						toggleFold: (key) => this.toggle(this.folded, key),
						opened: () => this.opened,
						toggleGap: (index) => this.toggle(this.opened, index),
						combined: {
							direction: this.options.direction,
							actions: (segment) => this.segmentActions(segment),
						},
					}),
					lineNumbers(),
					EditorView.domEventHandlers({
						// A click on a change's lines selects it, as one on its connector does.
						click: (event, view) => {
							if (view.state.selection.main.empty) {
								this.selectAt(view, side, event);
							}
							return false;
						},
					}),
					this.wrapping.extension(),
					EditorView.updateListener.of((update) => {
						if (update.geometryChanged || update.viewportChanged) {
							this.scheduleLayout();
						}
					}),
				],
			}),
			parent,
		});
	}

	private replaceDoc(view: EditorView | null, text: string): void {
		view?.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: text },
		});
	}

	private segmentActions(segment: CompareSegment): RailAction[] {
		if (!this.options.actionable) return [];
		const ref = { hunk: segment.hunk, segment: segment.segment };
		return choiceActions(
			this.options.direction,
			this.choices.kindOf(ref),
			(kind) => this.toggleChoice(ref, kind),
		);
	}

	private toggleChoice(
		ref: { hunk: number; segment: number },
		kind: EChoiceKind,
	): void {
		this.choices.toggle(ref, kind);
		this.redrawSegments();
		this.updateToolbar();
	}

	private toggle(set: Set<number>, key: number): void {
		if (!set.delete(key)) set.add(key);
		this.redrawSegments();
	}

	/** Choices and folds live outside the editors: both panes redraw, then the strip. */
	private redrawSegments(): void {
		this.rootEl?.toggleClass(
			"is-fully-folded",
			this.folded.size === this.segments.length,
		);
		for (const view of [this.leftView, this.rightView]) {
			view?.dispatch({ effects: segmentsChanged.of() });
		}
		this.refreshDivider();
	}

	private refreshDivider(): void {
		const left = this.leftView;
		const right = this.rightView;
		if (!left || !right || !this.divider) return;
		const near = this.nearSide();
		const far = near === "left" ? "right" : "left";
		const docs = { left: left.state.doc, right: right.state.doc };
		const side = (at: CompareSide) => ({
			doc: docs[at],
			changes: this.segments.map((segment) => segment[at]),
		});
		const bands = foldedBands(side(near), side(far), this.opened);
		const items: DividerItem[] = this.segments.map((segment) => ({
			key: segment.key,
			near: sideSpan(docs[near], segment[near]),
			far: sideSpan(docs[far], segment[far]),
			// The change's kind, never its direction or choice.
			tone: segmentKind(segment),
			actions: this.segmentActions(segment),
			pinned:
				this.pinChosen &&
				this.choices.kindOf({
					hunk: segment.hunk,
					segment: segment.segment,
				}) !== undefined,
		}));
		this.divider.update(items, bands);
	}

	private scrollPairs(): ScrollAnchors {
		const left = this.leftView;
		const right = this.rightView;
		if (!left || !right) return NO_ANCHORS;
		const segments = this.segments;
		return spanAnchors(left, right, segments.length, (index) => {
			const segment = segments[index] as CompareSegment;
			return [
				sideSpan(left.state.doc, segment.left),
				sideSpan(right.state.doc, segment.right),
			];
		});
	}

	private renderToolbar(root: HTMLElement): void {
		this.controls = new CompareControls();
		const toolbar = this.controls.controls;
		this.layoutMode = new LayoutMode(root, toolbar, (combined, changed) => {
			if (changed) {
				for (const view of [this.leftView, this.rightView]) {
					view?.dispatch({ effects: setCombinedMode.of(combined) });
				}
			}
			this.controls?.showPin(!combined);
			this.scheduleLayout();
		});
		this.wrapping.mount(toolbar);
		if (this.options.actionable) {
			this.controls.pinToggle(this.pinChosen, (enabled) => {
				this.pinChosen = enabled;
				this.options.onPinChosenChange(enabled);
				this.refreshDivider();
			});
		}
		this.controls.navigation((delta) => this.jump(delta));
	}

	private updateToolbar(): void {
		let added = 0;
		let removed = 0;
		for (const segment of this.segments) {
			added += segment.added;
			removed += segment.removed;
		}
		this.controls?.update(
			{ added, removed, changes: this.segments.length, current: this.current },
			this.options.direction,
			this.options.actionable,
			this.choices,
			() => this.discardChoices(),
			() => {
				if (this.choices.size > 0) this.options.onApply(this.choices);
			},
		);
	}

	private discardChoices(): void {
		this.choices.clear();
		this.redrawSegments();
		this.updateToolbar();
	}

	private selectAt(
		view: EditorView,
		side: CompareSide,
		event: MouseEvent,
	): void {
		const pos = view.posAtCoords(event);
		const line = pos === null ? -1 : view.state.doc.lineAt(pos).number - 1;
		this.selectSegment(
			this.segments.findIndex(
				({ [side]: [from, to] }) => from <= line && line < to,
			),
		);
	}

	/** From either pane or the strip; the change counter follows. */
	private selectSegment(index: number): void {
		this.divider?.select(this.segments[index]?.key ?? null);
		if (index < 0) return;
		this.current = index;
		this.updateToolbar();
	}

	private jump(delta: number): void {
		const segment = this.segments[this.nextIndex(delta)];
		if (!segment) return;
		this.divider?.select(segment.key);
		this.updateToolbar();
		// Landing alone does not say where the change is; a ring marks it for a moment.
		for (const overlay of this.overlays) overlay.flash(segment);
		this.scheduleLayout();
		const near = this.nearSide();
		const nearView = near === "left" ? this.leftView : this.rightView;
		if (!this.layoutMode?.combined && nearView && this.scrollSync) {
			const top = spanBounds(
				nearView,
				sideSpan(nearView.state.doc, segment[near]),
			).top;
			this.scrollSync.revealIn(nearView, top);
			return;
		}
		const right = this.rightView;
		if (!right) return;
		const at = sideSpan(right.state.doc, segment.right).from;
		right.dispatch({
			selection: { anchor: at },
			effects: EditorView.scrollIntoView(at, { y: "center" }),
		});
	}

	private nextIndex(delta: number): number {
		const count = this.segments.length;
		if (count === 0) return -1;
		this.current =
			this.current < 0
				? delta > 0
					? 0
					: count - 1
				: (this.current + delta + count) % count;
		return this.current;
	}

	private scheduleLayout(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			for (const view of [this.leftView, this.rightView]) {
				if (view) updatePaneViewportWidth(view);
			}
			this.divider?.layout();
			for (const overlay of this.overlays) {
				overlay.layout(this.segments, this.folded);
			}
		});
	}
}
