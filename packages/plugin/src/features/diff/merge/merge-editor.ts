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
import { randomId } from "@/core/crypto";
import { notifyError, notifyInfo, runWithNotice } from "@/core/ui";
import { eolOf } from "@/core/utils";
import {
	buildMergeSession,
	countUnresolved,
	type EMergeSide,
	MERGE_SIDES,
	type MergeChange,
} from "@/features/sync";
import type { PanelHosts } from "../header";
import type { DiffHost } from "../host";
import { LayoutMode } from "../layout-mode";
import {
	LineWrappingControl,
	type LineWrappingOptions,
} from "../line-wrapping-control";
import { Divider } from "../lines/divider";
import { sideSpan, updatePaneViewportWidth } from "../lines/geometry";
import {
	NO_ANCHORS,
	PaneScrollSync,
	type ScrollAnchors,
	spanAnchors,
} from "../lines/scroll-sync";
import { changeNavigation } from "../rail";
import { snapToLines } from "./edit-plan";
import { mergeActions } from "./merge-actions";
import { toggleMergeGap } from "./merge-cards";
import { dividerItems } from "./merge-controls";
import {
	mergeResultState,
	setCombinedMode,
	showSideChanges,
	sideDecorations,
} from "./merge-decorations";
import { keepMergeDraft, type MergeDraft, startMerge } from "./merge-drafts";
import { type SideMarks, sideMarks } from "./merge-marks";
import { MergeNavigation } from "./merge-navigation";
import {
	changeAt,
	initialMergeChanges,
	mergeChangesField,
} from "./merge-state";
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
	private layoutFrame: number | null = null;
	private layoutMode: LayoutMode | null = null;
	private wrapping: LineWrappingControl | null = null;
	private active = false;
	/** Opened from a draft: its edits count before any undo step exists. */
	private restored = false;
	/** A compare since opening saw other versions: Save will be refused. */
	private versionsChanged = false;

	private readonly dividerActions = mergeActions(() => ({
		view: this.resultView,
		sides: this.sides,
		base: this.base,
	}));

	private readonly nav = new MergeNavigation({
		result: () => this.resultView,
		changes: () => this.currentChanges(),
		paneSync: () => (this.layoutMode?.combined ? null : this.scrollSync),
		onSelect: (index) => {
			for (const side of MERGE_SIDES) {
				this.dividers[side]?.select(index < 0 ? null : index);
			}
			this.updateStatus();
		},
	});

	get isEditing(): boolean {
		return this.active;
	}

	/** Undoing every step back counts as none: nothing would be lost. */
	get hasEdits(): boolean {
		return (
			this.active &&
			!!this.resultView &&
			(this.restored || undoDepth(this.resultView.state) > 0)
		);
	}

	reset(): void {
		this.active = false;
		this.restored = false;
	}

	/** Obsidian cannot cancel a tab close: the edits wait for the next Merge of the same versions. */
	keepDraft(path: string): void {
		const view = this.resultView;
		if (!this.hasEdits || !view || !this.expected) return;
		keepMergeDraft(path, {
			text: view.state.doc.toString(),
			changes: view.state.field(mergeChangesField),
			expected: this.expected,
		});
	}

	/** Says it as soon as a compare finds the conflict at other versions, not only when Save fails. */
	checkVersions(current: MergeDraft["expected"] | undefined): void {
		const { expected } = this;
		if (!this.active || !current || !expected) return;
		const changed =
			current.localHash !== expected.localHash ||
			current.remoteHash !== expected.remoteHash;
		if (changed === this.versionsChanged) return;
		this.versionsChanged = changed;
		this.updateStatus();
		if (!changed) return;
		notifyInfo(
			"This file changed since its merge opened, so Save will be refused. Copy what you need from Result, then cancel and merge again.",
		);
	}

	/** Settles the change at the cursor, else the selected one, with these sides in order. */
	take(sides: readonly EMergeSide[]): void {
		const view = this.resultView;
		if (!view) return;
		const at = changeAt(view.state, view.state.selection.main.head);
		const index = at >= 0 ? at : this.nav.current;
		if (index >= 0) this.dividerActions.settle(index, sides);
		else notifyInfo("Put the cursor in a change first.");
	}

	/** `stillOn` says the view still shows `path` once the three versions arrive. */
	async enter(
		plugin: DiffHost,
		path: string,
		stillOn: () => boolean,
		onEntered: () => void,
	): Promise<void> {
		try {
			const texts = await plugin.controller.fileDiffs.getConflictThreeWay(path);
			// Another file opened meanwhile, or a merge began: this one would replace it unasked.
			if (!stillOn() || this.active) return;
			if (typeof texts === "string") {
				notifyError(`Cannot merge this file: ${texts}`);
				return;
			}
			const session = buildMergeSession(texts.base, texts.local, texts.remote);
			const start = startMerge(path, texts.expected, session);
			this.text = start.text;
			this.changes = start.changes;
			this.restored = start.restored;
			this.versionsChanged = false;
			this.base = session.baseLines;
			this.sides = {
				local: session.localLines,
				remote: session.remoteLines,
			};
			this.eol = eolOf(texts.local);
			this.expected = texts.expected;
			this.active = true;
			onEntered();
			if (start.notice) notifyInfo(start.notice);
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
		const toolbar = new MergeToolbar(() => this.nextConflict());
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
		toolbar.navigation((delta) => this.nav.jump(delta));
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
		const select = (key: number | null) => this.nav.select(key ?? -1);
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
					changeNavigation((delta) => this.nav.jump(delta)),
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
					changeNavigation((delta) => this.nav.jump(delta)),
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
			current: this.nav.current,
			canUndo: undoDepth(view.state) > 0,
			canRedo: redoDepth(view.state) > 0,
			versionsChanged: this.versionsChanged,
		});
	}

	nextConflict(): void {
		this.nav.nextConflict();
	}

	async save(
		plugin: DiffHost,
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
		this.nav.current = -1;
	}
}
