import {
	debounce,
	ItemView,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared";
import {
	EDiffDirection,
	type FileDiffModel,
	type HistoryVersionRef,
} from "@/sync/projection";
import { notifyError, redrawOnPhoneChange } from "@/ui/common";
import { openConfirmModal } from "@/ui/modals";
import { type ComparePanel, MergeEditorPanel, renderBinaryDiff } from "./diff";
import { renderTextDiff } from "./diff/compare-panel";
import {
	getAdjacentPath,
	getNextConflictPath,
	getOrderedPaths,
} from "./diff/file-navigation";
import { renderDiffFrame } from "./diff/header";
import {
	buildHistoryRequest,
	changesDiffer,
	compareActionable,
	type DiffViewState,
	type HistoryChange,
	selectHistoryMode,
} from "./diff/history-state";
import { DiffOperations } from "./diff/operations";
import { PreviewPanel } from "./diff/preview-panel";
import { openSourceControlView } from "./source-control-view";

export class DiffView extends ItemView {
	private readonly plugin: PluginHost;
	private readonly operations: DiffOperations;
	private path: string | null = null;
	private historyHash: string | null = null;
	private historyLabel = "Version";
	private historySize: number | undefined;
	private against: HistoryVersionRef | null = null;
	private historyChange: HistoryChange | null = null;
	private historyPreviewIfMissing = false;
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
	private rendering = false;
	private refreshPending = false;
	/** Merge… from source control asked for this path. */
	private mergeRequested: string | null = null;
	/** Monotonic generation counter; async loads discard results from older generations. */
	private loadGeneration = 0;

	constructor(leaf: WorkspaceLeaf, plugin: PluginHost) {
		super(leaf);
		this.plugin = plugin;
		this.operations = new DiffOperations(plugin, {
			state: () => ({
				path: this.path,
				historyHash: this.historyHash,
				historyChange: this.historyChange,
				model: this.model,
			}),
			refresh: () => this.refreshModel(),
			advance: (path) => this.advanceAfterResolve(path),
		});
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		if (!this.path) return "MDSync diff";
		return this.historyHash ? `History: ${this.path}` : `Diff: ${this.path}`;
	}

	getIcon(): string {
		return "git-compare";
	}

	getState(): Record<string, unknown> {
		// History fields belong here so a restored workspace preserves version diffs.
		return {
			path: this.path,
			historyHash: this.historyHash ?? undefined,
			historyLabel: this.historyHash ? this.historyLabel : undefined,
			historySize: this.historySize,
			againstHash: this.against?.hash,
			againstLabel: this.against?.label,
			againstSize: this.against?.size,
			historyChange: this.historyChange ?? undefined,
			historyPreviewIfMissing: this.historyPreviewIfMissing || undefined,
		};
	}

	async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		this.mergeRequested = state.merge ? (state.path ?? this.path) : null;
		const changed =
			(state.path && state.path !== this.path) ||
			(state.historyHash ?? null) !== this.historyHash ||
			(state.againstHash ?? null) !== (this.against?.hash ?? null) ||
			// A pin rename changes the label alone, and the header reads it.
			(state.historyHash !== undefined &&
				(state.historyLabel ?? "Version") !== this.historyLabel) ||
			changesDiffer(state.historyChange ?? null, this.historyChange) ||
			(state.historyPreviewIfMissing ?? false) !== this.historyPreviewIfMissing;
		if (changed) {
			if (!(await this.leaveMerge())) return;
			this.path = state.path ?? this.path;
			this.historyHash = state.historyHash ?? null;
			this.historyLabel = state.historyLabel ?? "Version";
			this.historySize = state.historySize;
			this.against = state.againstHash
				? {
						hash: state.againstHash,
						label: state.againstLabel ?? "Other version",
						size: state.againstSize,
					}
				: null;
			this.historyChange = state.historyChange ?? null;
			this.historyPreviewIfMissing = state.historyPreviewIfMissing ?? false;
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
		if (!this.path || this.mergeRequested !== this.path || !model) return;
		this.mergeRequested = null;
		if (
			model.direction !== EDiffDirection.Conflict ||
			model.isBinary ||
			this.mergePanel.isEditing
		) {
			return;
		}
		await this.mergePanel.enter(this.plugin, this.path, () =>
			this.renderShell(),
		);
	}

	private unsubStatus: (() => void) | null = null;
	private cancelStatusDebounce: (() => void) | null = null;

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mdsync-diff-view");
		this.headerEl = this.contentEl.createDiv({ cls: "mdsync-diff-header" });
		this.actionBarEl = this.contentEl.createDiv({
			cls: "mdsync-diff-action-bar",
		});
		this.bodyEl = this.contentEl.createDiv({ cls: "mdsync-diff-body" });
		const handleStatus = debounce(
			() => {
				if (this.path && !this.mergePanel.isEditing) void this.refreshModel();
			},
			200,
			true,
		);

		this.unsubStatus = this.plugin.controller.subscribe(handleStatus);
		this.cancelStatusDebounce = () => handleStatus.cancel();

		this.renderShell();
		redrawOnPhoneChange(this, () => this.redrawForPlatform());
	}

	async onClose(): Promise<void> {
		if (this.unsubStatus) {
			this.unsubStatus();
			this.unsubStatus = null;
		}
		this.cancelStatusDebounce?.();
		this.cancelStatusDebounce = null;
		this.loadGeneration++;
		this.refreshPending = false;
		this.destroyViews();
		this.contentEl.empty();
		this.bodyEl = null;
		this.headerEl = null;
		this.actionBarEl = null;
	}

	private async refreshModel(): Promise<void> {
		if (!this.path) return;
		if (this.rendering) {
			this.refreshPending = true;
			return;
		}
		this.rendering = true;
		const gen = this.loadGeneration;
		try {
			if (!this.model) this.renderLoading();
			if (this.historyHash) {
				const request = buildHistoryRequest({
					path: this.path,
					historyHash: this.historyHash,
					historyLabel: this.historyLabel,
					historySize: this.historySize,
					historyChange: this.historyChange,
					against: this.against,
					forceText: this.forceText,
				});
				const model =
					await this.plugin.controller.history.getHistoryDiff(request);
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
				? await this.plugin.controller.fileDiffs.getForcedFileDiff(this.path)
				: await this.plugin.controller.fileDiffs.getFileDiff(this.path);
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
			else this.renderError(errorMessage(err));
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
		const path = this.path ?? "";
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
				against: this.against,
				historyChange: this.historyChange,
				historyLabel: this.historyLabel,
			},
			{
				saveResolution: () =>
					void this.mergePanel.save(this.plugin, path, (resolved: string) =>
						this.advanceAfterResolve(resolved),
					),
				cancelResolution: () =>
					void this.leaveMerge().then((leave) => {
						if (!leave) return;
						this.mergePanel.reset();
						this.renderShell();
					}),
				restoreVersion: () => void this.operations.restoreVersion(),
				keepLocal: () => void this.operations.keepLocal(),
				acceptRemote: () => void this.operations.acceptRemote(),
				keepBothVersions: () => void this.operations.keepBoth(),
				startMerge: () =>
					void this.mergePanel.enter(this.plugin, path, () =>
						this.renderShell(),
					),
				goPrevFile: () => void this.navigateFile(-1),
				goNextFile: () => void this.navigateFile(1),
				goBack: () =>
					void this.leaveMerge().then((leave) => {
						if (leave) void this.returnToSourceControl();
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
			selectHistoryMode({
				historyHash: this.historyHash,
				historyChange: this.historyChange,
				historyPreviewIfMissing: this.historyPreviewIfMissing,
				against: this.against,
				localExists: model.rightPresent,
			}) === "preview";
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
			this.previewPanel.render(body, model.leftText, this.historyLabel);
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
		return compareActionable({
			model,
			against: this.against,
			historyChange: this.historyChange,
		});
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
		await openSourceControlView(this.app, SOURCE_CONTROL_VIEW_TYPE);
		this.leaf.detach();
	}

	private async navigateFile(delta: number): Promise<void> {
		// Re-read at click time: the list captured at render goes stale once anything syncs.
		const target = getAdjacentPath(
			getOrderedPaths(this.plugin.controller.getSnapshot().result?.diff),
			this.path,
			delta,
		);
		if (!target || !(await this.leaveMerge())) return;
		this.showFile(target);
		await this.refreshModel();
	}

	/** False when the user keeps an unsaved merge on screen. */
	private async leaveMerge(): Promise<boolean> {
		if (!this.mergePanel.hasEdits) return true;
		return openConfirmModal({
			app: this.app,
			title: "Discard this merge?",
			body: ["The merged result is not saved. Leaving drops your edits to it."],
			confirmLabel: "Discard",
			cancelLabel: "Keep merging",
			confirmClass: "mod-warning",
		});
	}

	private showFile(path: string): void {
		this.path = path;
		this.historyHash = null;
		this.historyLabel = "Version";
		this.historySize = undefined;
		this.against = null;
		this.historyChange = null;
		this.historyPreviewIfMissing = false;
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
