import {
	ItemView,
	type Menu,
	Scope,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE } from "@/core/constants";
import { userMessage } from "@/core/shared";
import { notifyError, redrawOnPhoneChange } from "@/core/ui";
import type { CompareResult, EMergeSide } from "@/features/sync";
import { EDiffDirection, type FileDiffModel } from "@/features/sync";
import { watchDiffChrome } from "./action-bar";
import { renderBinaryDiff } from "./compare/binary-view";
import { type ComparePanel, renderTextDiff } from "./compare/compare-panel";
import { PreviewPanel } from "./compare/preview-panel";
import {
	getAdjacentPath,
	getNextConflictPath,
	getOrderedPaths,
} from "./file-navigation";
import { refitDiffTitle, renderDiffFrame } from "./header";
import {
	buildHistoryRequest,
	compareActionable,
	type DiffViewState,
	fileTarget,
	readTarget,
	sameTarget,
	selectHistoryMode,
	targetState,
} from "./history-state";
import type { DiffHost } from "./host";
import { MergeEditorPanel } from "./merge/merge-editor";
import { DiffOperations } from "./operations";
import { addCopyItems } from "./ui/copy-menu";
import { confirmLeave } from "./ui/leave-guard";

/** A merge open in a diff view, as commands reach it. */
export interface ActiveMerge {
	take(sides: readonly EMergeSide[]): void;
	nextConflict(): void;
	save(): void;
}

export class DiffView extends ItemView {
	private readonly plugin: DiffHost;
	private readonly operations: DiffOperations;
	private target = fileTarget(null);
	private model: FileDiffModel | null = null;
	private readonly mergePanel = new MergeEditorPanel();
	private comparePanel: ComparePanel | null = null;
	private previewPanel: PreviewPanel | null = null;
	private forceText = false;
	private lineWrapping = true;
	private pinChosen = true;
	private headerEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private actionBarEl: HTMLElement | null = null;
	private chrome: MutationObserver | null = null;
	private rendering = false;
	private refreshPending = false;
	/** Merge… from source control asked for this path. */
	private mergeRequested: string | null = null;
	/** Monotonic generation counter; async loads discard results from older generations. */
	private loadGeneration = 0;

	constructor(leaf: WorkspaceLeaf, plugin: DiffHost) {
		super(leaf);
		this.plugin = plugin;
		this.operations = new DiffOperations(plugin, {
			state: () => ({ ...this.target, model: this.model }),
			refresh: () => this.refreshModel(),
			advance: (path) => this.advanceAfterResolve(path),
		});
		// Obsidian's own Mod+F (search in a note) runs before the panes' CodeMirror keys.
		// Uppercase matches the key's position, so any keyboard layout.
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "F", () => {
			const panel = this.mergePanel.isEditing
				? this.mergePanel
				: this.comparePanel;
			panel?.search.toggleFocused();
			return false;
		});
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		const { path, historyHash } = this.target;
		if (!path) return "MDSync diff";
		return historyHash ? `History: ${path}` : `Diff: ${path}`;
	}

	getIcon(): string {
		return "git-compare";
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const { path } = this.target;
		if (path) addCopyItems(menu, path, this.model);
	}

	getState(): Record<string, unknown> {
		return { ...targetState(this.target) };
	}

	async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		const next = readTarget(state, this.target.path);
		this.mergeRequested = state.merge ? next.path : null;
		if (!sameTarget(next, this.target)) {
			if (!(await this.mayLeave())) return;
			this.target = next;
			this.model = null;
			this.mergePanel.reset();
			this.forceText = false;
			this.loadGeneration++;
			this.destroyViews();
			await this.refreshModel();
		}
		await this.enterRequestedMerge();
		await super.setState(state, result);
	}

	/** Once the requested path's model is in: a load still queued behind another finishes later. */
	private async enterRequestedMerge(): Promise<void> {
		const model = this.model;
		const { path } = this.target;
		if (!path || this.mergeRequested !== path || !model) return;
		this.mergeRequested = null;
		if (
			model.direction !== EDiffDirection.Conflict ||
			model.isBinary ||
			this.mergePanel.isEditing
		) {
			return;
		}
		await this.mergePanel.enter(this.plugin, path, this.stillShowing(), () =>
			this.renderShell(),
		);
	}

	/** A file opened since, even this one again, makes what was asked for it stale. */
	private stillShowing(): () => boolean {
		const gen = this.loadGeneration;
		return () => gen === this.loadGeneration;
	}

	private unsubStatus: (() => void) | null = null;
	/** Only a compare or a finished operation changes what a diff reads; progress broadcasts change neither. */
	private seenResult: CompareResult | null = null;
	private seenBusy = false;
	private stale = false;

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mdsync-diff-view");
		this.headerEl = this.contentEl.createDiv({ cls: "mdsync-diff-header" });
		this.actionBarEl = this.contentEl.createDiv({
			cls: "mdsync-diff-action-bar",
		});
		this.bodyEl = this.contentEl.createDiv({ cls: "mdsync-diff-body" });
		this.chrome = watchDiffChrome(this.headerEl, this.actionBarEl);
		({ result: this.seenResult, busy: this.seenBusy } =
			this.plugin.controller.getSnapshot());
		this.unsubStatus = this.plugin.controller.subscribe(({ result, busy }) => {
			// A failed operation can write files and keep the result it started from.
			const settled = this.seenBusy && !busy;
			this.seenBusy = busy;
			if (result === this.seenResult && !settled) return;
			this.seenResult = result;
			const { path, against, historyChange } = this.target;
			if (result && path && this.mergePanel.isEditing) {
				const status = this.plugin.controller.fileDiffs.getStatusForPath(path);
				this.mergePanel.checkVersions(status?.conflict);
			}
			// Stored versions are immutable: a compare cannot change them.
			if (against || historyChange) return;
			this.stale = true;
			this.onResize();
		});

		this.renderShell();
		redrawOnPhoneChange(this, () => this.redrawForPlatform());
	}

	/** Obsidian resizes a tab when it is shown again: the reload a hidden tab skipped. */
	onResize(): void {
		refitDiffTitle(this.containerEl);
		if (!this.stale || !this.target.path || this.mergePanel.isEditing) return;
		if (!this.containerEl.isShown()) return;
		this.stale = false;
		void this.refreshModel();
	}

	async onClose(): Promise<void> {
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}
		this.loadGeneration++;
		this.chrome?.disconnect();
		this.chrome = null;
		this.refreshPending = false;
		if (this.target.path) this.mergePanel.keepDraft(this.target.path);
		this.destroyViews();
		this.contentEl.empty();
		this.bodyEl = null;
		this.headerEl = null;
		this.actionBarEl = null;
	}

	private async refreshModel(): Promise<void> {
		const target = this.target;
		const { path, historyHash } = target;
		if (!path) return;
		if (this.rendering) {
			this.refreshPending = true;
			return;
		}
		this.rendering = true;
		const gen = this.loadGeneration;
		try {
			if (!this.model) this.renderLoading();
			if (historyHash) {
				const model = await this.plugin.controller.history.getHistoryDiff(
					buildHistoryRequest({
						...target,
						path,
						historyHash,
						forceText: this.forceText,
					}),
				);
				if (gen !== this.loadGeneration) return;
				this.model = model;
				if (!this.model) {
					this.renderError("This version is no longer available.");
					return;
				}
				this.renderShell();
				return;
			}
			const model = this.forceText
				? await this.plugin.controller.fileDiffs.getForcedFileDiff(path)
				: await this.plugin.controller.fileDiffs.getFileDiff(path);
			if (gen !== this.loadGeneration) return;
			this.model = model;

			if (!this.model) {
				// No compare yet (startup, a reset) is not "no differences": the next one refreshes this.
				if (!this.plugin.controller.getSnapshot().result) {
					this.renderMessage("Waiting for a compare…");
					return;
				}
				this.leaf.detach();
				return;
			}

			this.renderShell();
			void this.enterRequestedMerge();
		} catch (err) {
			if (gen !== this.loadGeneration) return;
			if (this.model) notifyError("Refresh failed", err);
			else this.renderError(userMessage(err));
		} finally {
			this.rendering = false;
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.refreshModel();
			}
		}
	}

	private renderLoading(): void {
		this.renderMessage("Loading...");
	}

	private renderError(message: string): void {
		this.renderMessage(`Error: ${message}`);
	}

	private renderMessage(text: string): void {
		if (!this.bodyEl) return;
		this.destroyViews();
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "mdsync-diff-empty", text });
		this.renderHeader();
	}

	private redrawForPlatform(): void {
		if (this.mergePanel.isEditing) {
			this.renderHeader();
			return;
		}
		this.destroyViews();
		this.renderShell();
	}

	private renderShell(): void {
		this.renderBody();
		this.renderHeader();
	}

	private renderHeader(): void {
		const header = this.headerEl;
		const actionBar = this.actionBarEl;
		if (!header || !actionBar) return;
		const { against, historyChange, historyLabel } = this.target;
		const path = this.target.path ?? "";
		renderDiffFrame(
			header,
			actionBar,
			{
				path,
				paths: getOrderedPaths(
					this.plugin.controller.getSnapshot().result?.diff,
				),
				model: this.model,
				isEditing: this.mergePanel.isEditing,
				against,
				historyChange,
				historyLabel,
			},
			{
				saveResolution: () => this.saveMerge(path),
				cancelResolution: () =>
					void this.mayLeave().then((leave) => {
						if (!leave) return;
						this.mergePanel.reset();
						this.renderShell();
					}),
				restoreVersion: () => void this.operations.restoreVersion(),
				keepLocal: () => void this.operations.keepLocal(),
				acceptRemote: () => void this.operations.acceptRemote(),
				keepBothVersions: () => void this.operations.keepBoth(),
				startMerge: () =>
					void this.mergePanel.enter(
						this.plugin,
						path,
						this.stillShowing(),
						() => this.renderShell(),
					),
				goPrevFile: () => void this.navigateFile(-1),
				goNextFile: () => void this.navigateFile(1),
				goBack: () =>
					void this.mayLeave().then((leave) => {
						if (!leave) return;
						// Discarded here, so closing the tab keeps no draft of it.
						this.mergePanel.reset();
						void this.returnToSourceControl();
					}),
			},
			this.mergePanel.isEditing ? this.mergePanel : this.comparePanel,
		);
	}

	private renderBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		const model = this.model;
		const preview =
			model &&
			selectHistoryMode({ ...this.target, localExists: model.rightPresent }) ===
				"preview";
		if (
			model &&
			!preview &&
			!model.isBinary &&
			!this.mergePanel.isEditing &&
			this.comparePanel &&
			model.hunks.hunks.length > 0 &&
			this.comparePanel.update(model, this.compareActionable(model))
		)
			return;
		body.empty();
		this.destroyViews();
		if (!model) {
			body.createDiv({ cls: "mdsync-diff-empty", text: "No diff data." });
			return;
		}
		if (model.isBinary) {
			renderBinaryDiff(body, model, this.forceText, () => {
				this.forceText = true;
				void this.refreshModel();
			});
			return;
		}
		if (this.mergePanel.isEditing) {
			this.mergePanel.render(body, {
				lineWrapping: this.lineWrapping,
				onLineWrappingChange: (enabled) => {
					this.lineWrapping = enabled;
				},
			});
			return;
		}
		if (preview) {
			this.previewPanel = new PreviewPanel();
			this.previewPanel.render(body, model.leftText, this.target.historyLabel);
			return;
		}
		this.comparePanel = renderTextDiff(body, model, {
			direction: model.direction,
			actionable: this.compareActionable(model),
			lineWrapping: this.lineWrapping,
			onLineWrappingChange: (enabled) => {
				this.lineWrapping = enabled;
			},
			pinChosen: this.pinChosen,
			onPinChosenChange: (enabled) => {
				this.pinChosen = enabled;
			},
			onApply: (choices) => void this.operations.applyChoices(choices),
		});
	}

	private compareActionable(model: FileDiffModel): boolean {
		return compareActionable({ ...this.target, model });
	}

	private async advanceAfterResolve(resolvedPath: string): Promise<void> {
		const next = getNextConflictPath(
			this.plugin.controller.getSnapshot().result?.diff,
			resolvedPath,
		);
		if (next) {
			this.showFile(next);
			await this.refreshModel();
			return;
		}
		await this.returnToSourceControl();
	}

	private async returnToSourceControl(): Promise<void> {
		// Detached first: the leaf Obsidian activates after it, a tick later, closes a phone's drawer.
		this.leaf.detach();
		await sleep(0);
		await this.plugin.openSourceControl();
	}

	private async navigateFile(delta: number): Promise<void> {
		// Re-read at click time: the list captured at render goes stale once anything syncs.
		const target = getAdjacentPath(
			getOrderedPaths(this.plugin.controller.getSnapshot().result?.diff),
			this.target.path,
			delta,
		);
		if (!target || !(await this.mayLeave())) return;
		this.showFile(target);
		await this.refreshModel();
	}

	/** What merge commands act on; null unless this view is merging. */
	get merge(): ActiveMerge | null {
		const { path } = this.target;
		if (!this.mergePanel.isEditing || !path) return null;
		return {
			take: (sides) => this.mergePanel.take(sides),
			nextConflict: () => this.mergePanel.nextConflict(),
			save: () => this.saveMerge(path),
		};
	}

	private saveMerge(path: string): void {
		void this.mergePanel.save(this.plugin, path, (resolved) =>
			this.advanceAfterResolve(resolved),
		);
	}

	private mayLeave(): Promise<boolean> {
		return confirmLeave(this.app, {
			mergeEdits: this.mergePanel.hasEdits,
			picked: this.comparePanel?.choices.size ?? 0,
		});
	}

	private showFile(path: string): void {
		this.target = fileTarget(path);
		this.model = null;
		this.forceText = false;
		this.loadGeneration++;
		this.mergePanel.reset();
		this.destroyViews();
		(this.leaf as Partial<{ updateHeader: () => void }>).updateHeader?.();
	}

	private destroyViews(): void {
		this.mergePanel.destroy();
		this.comparePanel?.destroy();
		this.comparePanel = null;
		this.previewPanel?.destroy();
		this.previewPanel = null;
	}
}
