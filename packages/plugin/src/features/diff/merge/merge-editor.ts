import {
	history,
	historyKeymap,
	redo,
	redoDepth,
	undo,
	undoDepth,
} from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { setIcon } from "obsidian";
import type { PluginHost } from "@/app/host";
import { randomId } from "@/core/crypto";
import { notifyError, notifyInfo, runWithNotice } from "@/core/ui";
import { eolOf } from "@/core/utils";
import {
	buildMergeSession,
	countUnresolved,
	type EMergeSide,
	isResolved,
	MERGE_SIDES,
	type MergeChange,
	snapToLines,
} from "@/features/sync";
import type { PanelHosts } from "../header";
import { LayoutMode } from "../layout-mode";
import {
	LineWrappingControl,
	type LineWrappingOptions,
} from "../line-wrapping-control";
import { Divider } from "../lines/divider";
import {
	sideSpan,
	spanBounds,
	updatePaneViewportWidth,
} from "../lines/geometry";
import {
	NO_ANCHORS,
	PaneScrollSync,
	type ScrollAnchors,
	spanAnchors,
} from "../lines/scroll-sync";
import { changeNavigation } from "../rail";
import { mergeActions } from "./merge-actions";
import { toggleMergeGap } from "./merge-cards";
import { dividerItems } from "./merge-controls";
import {
	mergeResultState,
	setCombinedMode,
	showSideChanges,
	sideDecorations,
} from "./merge-decorations";
import { type SideMarks, sideMarks } from "./merge-marks";
import { initialMergeChanges, mergeChangesField } from "./merge-state";
import { MergeToolbar } from "./merge-toolbar";

export class MergeEditorPanel {
	private text = "";
	private changes: readonly MergeChange[] = [];
	private sides: Record<EMergeSide, string[]> = { local: [], remote: [] };
	private base: string[] = [];
	private eol = "\n";
	private expected: { localHash: string; remoteHash: string } | null = null;
	private resultView: EditorView | null = null;
	private sideViews: Partial<Record<EMergeSide, EditorView>> = {};
	private dividers: Partial<Record<EMergeSide, Divider>> = {};
	private scrollSync: PaneScrollSync | null = null;
	private toolbar: MergeToolbar | null = null;
	/** The selected change, or -1. */
	private current = -1;
	private layoutFrame: number | null = null;
	private layoutMode: LayoutMode | null = null;
	private wrapping: LineWrappingControl | null = null;
	private active = false;

	private readonly dividerActions = mergeActions(() => ({
		view: this.resultView,
		sides: this.sides,
		base: this.base,
	}));

	get isEditing(): boolean {
		return this.active;
	}

	/** Undoing every step back counts as none: nothing would be lost. */
	get hasEdits(): boolean {
		return (
			this.active && !!this.resultView && undoDepth(this.resultView.state) > 0
		);
	}

	reset(): void {
		this.active = false;
	}

	/** `stillOn` says the view still shows `path` once the three versions arrive. */
	async enter(
		plugin: PluginHost,
		path: string,
		stillOn: () => boolean,
		onEntered: () => void,
	): Promise<void> {
		try {
			const texts = await plugin.controller.fileDiffs.getConflictThreeWay(path);
			// Another file opened meanwhile, or a merge began: this one would replace it unasked.
			if (!stillOn() || this.active) return;
			if (!texts) {
				notifyError(
					"Cannot three-way merge this file (binary or no common ancestor). Use Keep local / Accept remote.",
				);
				return;
			}
			const session = buildMergeSession(texts.base, texts.local, texts.remote);
			this.text = session.text;
			this.changes = session.changes;
			this.base = session.baseLines;
			this.sides = {
				local: session.localLines,
				remote: session.remoteLines,
			};
			this.eol = eolOf(texts.local);
			this.expected = texts.expected;
			this.active = true;
			onEntered();
			if (!session.changes.some((change) => change.conflict)) {
				notifyInfo("No overlapping changes - auto-merged. Review and save.");
			}
		} catch (err) {
			notifyError("Merge failed", err);
		}
	}

	render(parent: HTMLElement, options: LineWrappingOptions): void {
		this.destroy();
		this.wrapping = new LineWrappingControl(
			options,
			() => [...Object.values(this.sideViews), this.resultView],
			() => this.scheduleLayout(),
		);
		const root = parent.createDiv({ cls: "mdsync-merge-panel" });
		this.renderToolbar(root);
		this.renderDesktop(root);
		this.layoutMode?.refresh();
		this.updateStatus();
	}

	mount(hosts: PanelHosts): void {
		this.toolbar?.mount(hosts);
		this.layoutMode?.refresh();
	}

	private renderToolbar(root: HTMLElement): void {
		const toolbar = new MergeToolbar(() => this.jumpToConflict());
		this.toolbar = toolbar;
		this.layoutMode = new LayoutMode(
			root,
			toolbar.controls,
			(combined, changed) => {
				if (changed) {
					this.resultView?.dispatch({ effects: setCombinedMode.of(combined) });
				}
				this.scheduleLayout();
			},
		);
		this.wrapping?.mount(toolbar.controls);
		toolbar.undoRedo(
			() => this.resultView && undo(this.resultView),
			() => this.resultView && redo(this.resultView),
		);
		toolbar.navigation((delta) => this.jump(delta));
	}

	private renderDesktop(root: HTMLElement): void {
		const heads = root.createDiv({ cls: "mdsync-merge-pane-heads" });
		const body = root.createDiv({ cls: "mdsync-merge-body" });
		const pane = (cls: string, name: string, note: string, id?: string) => {
			const head = heads.createDiv({ cls: `mdsync-merge-pane-head ${cls}` });
			if (id) head.id = id;
			const mark = head.createSpan({ cls: "mdsync-merge-pane-mark" });
			if (cls === "is-result") setIcon(mark, "pencil");
			head.createSpan({ cls: "mdsync-merge-pane-name", text: name });
			head.createSpan({ cls: "mdsync-merge-pane-note", text: note });
			return body.createDiv({ cls: `mdsync-merge-editor-host ${cls}` });
		};
		const strip = (cls: string) => {
			heads.createDiv({ cls: "mdsync-merge-divider-head" });
			return body.createDiv({ cls: `mdsync-merge-divider ${cls}` });
		};
		const resultLabel = randomId();
		const localHost = pane("is-local", "Local", "this device");
		const leftEl = strip("is-local");
		const resultHost = pane(
			"is-result",
			"Result",
			"you can type here",
			resultLabel,
		);
		const rightEl = strip("is-remote");
		const remoteHost = pane("is-remote", "Remote", "incoming");

		const marks = sideMarks(this.base, this.sides);
		const local = this.makeSideEditor(localHost, "local", marks);
		const result = this.makeResultEditor(resultHost, marks, resultLabel);
		const remote = this.makeSideEditor(remoteHost, "remote", marks);
		this.sideViews = { local, remote };
		const select = (key: number | null) => this.select(key ?? -1);
		this.dividers = {
			local: new Divider(leftEl, local, result, "left", select),
			remote: new Divider(rightEl, remote, result, "right", select),
		};
		this.scrollSync = new PaneScrollSync(
			[
				{ a: local, b: result, pairs: () => this.scrollPairs("local") },
				{ a: remote, b: result, pairs: () => this.scrollPairs("remote") },
			],
			() => this.scheduleLayout(),
		);
		this.syncModel();
	}

	private scrollPairs(side: EMergeSide): ScrollAnchors {
		const sideView = this.sideViews[side];
		const result = this.resultView;
		if (!sideView || !result) return NO_ANCHORS;
		const changes = this.currentChanges();
		return spanAnchors(sideView, result, changes.length, (index) => {
			const change = changes[index] as MergeChange;
			return [
				sideSpan(sideView.state.doc, change[side]),
				snapToLines(result.state.doc, change.result),
			];
		});
	}

	private makeSideEditor(
		parent: HTMLElement,
		side: EMergeSide,
		marks: SideMarks,
	): EditorView {
		return new EditorView({
			state: EditorState.create({
				doc: this.sides[side].join("\n"),
				extensions: [
					EditorState.readOnly.of(true),
					changeNavigation((delta) => this.jump(delta)),
					lineNumbers(),
					this.wrapping?.extension() ?? [],
					sideDecorations(side, marks),
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

	private makeResultEditor(
		parent: HTMLElement,
		marks: SideMarks,
		labelId: string,
	): EditorView {
		const view = new EditorView({
			state: EditorState.create({
				doc: this.text,
				extensions: [
					initialMergeChanges.of(this.changes),
					mergeResultState({
						actions: this.dividerActions,
						base: this.base,
						sides: this.sides,
						marks,
						toggleGap: (index) =>
							this.resultView?.dispatch({ effects: toggleMergeGap.of(index) }),
					}),
					history(),
					// Labelled by the pane head: an aria-label shows Obsidian's tooltip over the whole editor.
					EditorView.contentAttributes.of({ "aria-labelledby": labelId }),
					changeNavigation((delta) => this.jump(delta)),
					keymap.of(historyKeymap),
					lineNumbers(),
					this.wrapping?.extension() ?? [],
					EditorView.updateListener.of((update) => {
						const modelChanged =
							update.startState.field(mergeChangesField) !==
							update.state.field(mergeChangesField);
						if (modelChanged) this.syncModel();
						else if (update.geometryChanged || update.viewportChanged) {
							this.scheduleLayout();
						}
						if (update.docChanged || modelChanged) this.updateStatus();
					}),
				],
			}),
			parent,
		});
		this.resultView = view;
		return view;
	}

	private syncModel(): void {
		const changes = this.currentChanges();
		const result = this.resultView;
		for (const side of MERGE_SIDES) {
			const view = this.sideViews[side];
			if (!view || !result) continue;
			showSideChanges(view, changes);
			this.dividers[side]?.update(
				dividerItems(
					changes,
					side,
					view.state.doc,
					result.state.doc,
					this.dividerActions,
				),
			);
		}
		this.scheduleLayout();
	}

	private currentChanges(): readonly MergeChange[] {
		return this.resultView?.state.field(mergeChangesField) ?? this.changes;
	}

	private scheduleLayout(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			for (const view of [...Object.values(this.sideViews), this.resultView]) {
				if (view) updatePaneViewportWidth(view);
			}
			for (const side of MERGE_SIDES) this.dividers[side]?.layout();
		});
	}

	private updateStatus(): void {
		const view = this.resultView;
		if (!view) return;
		const changes = this.currentChanges();
		this.toolbar?.update({
			unresolved: countUnresolved(changes),
			total: changes.length,
			current: this.current,
			canUndo: undoDepth(view.state) > 0,
			canRedo: redoDepth(view.state) > 0,
		});
	}

	/** Raises the change on both strips and shows its position. */
	private select(index: number): void {
		this.current = index;
		for (const side of MERGE_SIDES) {
			this.dividers[side]?.select(index < 0 ? null : index);
		}
		this.updateStatus();
	}

	private jump(delta: number): void {
		const total = this.currentChanges().length;
		if (total === 0) return;
		let next = (this.current + delta + total) % total;
		if (this.current < 0) next = delta > 0 ? 0 : total - 1;
		this.reveal(next);
	}

	/** The next unresolved change after the selected one, wrapping round. */
	private jumpToConflict(): void {
		const changes = this.currentChanges();
		const total = changes.length;
		for (let step = 1; step <= total; step++) {
			const index = (Math.max(this.current, -1) + step) % total;
			const change = changes[index];
			if (change && !isResolved(change)) {
				this.reveal(index);
				return;
			}
		}
	}

	private reveal(index: number): void {
		const view = this.resultView;
		const target = this.currentChanges()[index];
		if (!view || !target) return;
		// The strips show its buttons, so the keyboard reaches them with Tab.
		this.select(index);
		const combined = this.layoutMode?.combined ?? false;
		view.dispatch({
			selection: { anchor: target.result.from },
			effects:
				this.scrollSync && !combined
					? []
					: EditorView.scrollIntoView(target.result.from, { y: "center" }),
		});
		if (!combined && this.scrollSync) {
			const top = spanBounds(
				view,
				snapToLines(view.state.doc, target.result),
			).top;
			this.scrollSync.revealIn(view, top);
		}
		view.focus();
	}

	async save(
		plugin: PluginHost,
		path: string,
		onSaved: (resolvedPath: string) => Promise<void>,
	): Promise<void> {
		const view = this.resultView;
		if (!view) return;
		if (countUnresolved(this.currentChanges()) > 0) {
			notifyError("Resolve every conflict before saving.");
			return;
		}
		const { expected } = this;
		if (!expected) return;
		const text = view.state.doc.toString().replace(/\n/g, this.eol);
		try {
			const saved = await runWithNotice(
				() => plugin.controller.resolveConflictMerged(path, text, expected),
				"Conflict resolved with merged content.",
				"Save resolution failed",
			);
			if (!saved) return;
			this.active = false;
			await onSaved(path);
		} catch (err) {
			notifyError("Save resolution failed", err);
		}
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
		for (const divider of Object.values(this.dividers)) divider?.destroy();
		this.dividers = {};
		this.resultView?.destroy();
		this.resultView = null;
		for (const view of Object.values(this.sideViews)) view.destroy();
		this.sideViews = {};
		this.toolbar?.info.remove();
		this.toolbar?.controls.remove();
		this.toolbar = null;
		this.wrapping = null;
		this.current = -1;
	}
}
