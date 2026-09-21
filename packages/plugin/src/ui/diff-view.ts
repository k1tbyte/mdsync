import {
	debounce,
	ItemView,
	Platform,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { DIFF_VIEW_TYPE, SOURCE_CONTROL_VIEW_TYPE } from "@/constants";
import type { PluginHost } from "@/plugin/host";
import { errorMessage } from "@/shared/errors";
import { HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import {
	EDiffDirection,
	type FileDiffModel,
	type HistoryVersionRef,
} from "@/sync/projection";
import {
	ComparePanel,
	MergeEditorPanel,
	renderBinaryDiff,
	renderDiffHeader,
} from "./diff";
import {
	buildHistoryRequest,
	changesDiffer,
	type HistoryChange,
	hunkHintText,
	selectHistoryMode,
} from "./diff/history-state";
import { DiffOperations } from "./diff/operations";
import { PreviewPanel } from "./diff/preview-panel";
import { notifyError } from "./notices";
import { openSourceControlView } from "./source-control-view";

interface DiffViewState {
	path?: string;
	historyHash?: string;
	historyLabel?: string;
	historySize?: number;
	/** Set to diff two stored versions instead of a version against the vault. */
	againstHash?: string;
	againstLabel?: string;
	againstSize?: number;
	/** Before/after refs for a historical change diff (timeline file click). */
	historyChange?: HistoryChange;
	/** When true and local file is missing, show read-only preview instead of deletion diff. */
	historyPreviewIfMissing?: boolean;
}

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
	private headerEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private rendering = false;
	private refreshPending = false;
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
		if (!this.path) return "Obsync diff";
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
		await super.setState(state, result);
	}

	private unsubStatus: (() => void) | null = null;
	private cancelStatusDebounce: (() => void) | null = null;

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("obsync-diff-view");
		this.contentEl.toggleClass("obsync-is-phone", Platform.isPhone);
		this.headerEl = this.contentEl.createDiv({ cls: "obsync-diff-header" });
		this.bodyEl = this.contentEl.createDiv({ cls: "obsync-diff-body" });
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
				// No differences remaining; auto-close.
				this.leaf.detach();
				return;
			}

			this.renderShell();
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
		this.renderHeader();
		this.renderMessage("Loading...");
	}

	private renderError(message: string): void {
		this.renderMessage(`Error: ${message}`);
	}

	private renderMessage(text: string): void {
		if (!this.bodyEl) return;
		this.destroyViews();
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "obsync-diff-empty", text });
	}

	private renderShell(): void {
		const fileActions = this.renderHeader();
		this.renderBody();
		if (fileActions) this.comparePanel?.mountFileActions(fileActions);
	}

	private renderHeader(): HTMLElement | null {
		const header = this.headerEl;
		if (!header) return null;
		const path = this.path ?? "";
		const paths = this.getOrderedPaths();
		return renderDiffHeader(
			header,
			{
				path,
				direction: this.model?.direction ?? null,
				isBinary: this.model?.isBinary ?? false,
				isEditing: this.mergePanel.isEditing,
				canGoPrevFile: this.getAdjacentPath(paths, -1) !== null,
				canGoNextFile: this.getAdjacentPath(paths, 1) !== null,
				showBack: Platform.isPhone,
				restoreLabel: this.against
					? `Restore ${this.historyLabel}`
					: "Restore this version",
			},
			{
				saveResolution: () =>
					void this.mergePanel.save(this.plugin, path, (resolved) =>
						this.advanceAfterResolve(resolved),
					),
				cancelResolution: () => {
					this.mergePanel.reset();
					this.renderShell();
				},
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
				goBack: () => void this.returnToSourceControl(),
			},
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
			body.createDiv({ cls: "obsync-diff-empty", text: "No diff data." });
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
				showLineWrappingToggle: Platform.isPhone,
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
		this.renderTextDiff(body, model);
	}

	private renderTextDiff(parent: HTMLElement, model: FileDiffModel): void {
		if (model.hunks.hunks.length === 0) {
			parent.createDiv({
				cls: "obsync-diff-empty",
				text: "No textual differences.",
			});
			return;
		}
		const actionable = this.compareActionable(model);
		this.comparePanel = new ComparePanel({
			direction: model.direction,
			actionable,
			lineWrapping: this.lineWrapping,
			showLineWrappingToggle: Platform.isPhone,
			onLineWrappingChange: (enabled) => {
				this.lineWrapping = enabled;
			},
			onApply: (choices) => void this.operations.applyChoices(choices),
		});
		this.comparePanel.render(parent, model);
		if (!actionable) {
			parent.createDiv({
				cls: "obsync-diff-hint",
				text: this.hunkHintText(model),
			});
		}
	}

	private compareActionable(model: FileDiffModel): boolean {
		const tooLarge =
			model.leftSize > HUNK_TEXT_MAX_BYTES ||
			model.rightSize > HUNK_TEXT_MAX_BYTES;
		return (
			!tooLarge &&
			this.against === null &&
			this.historyChange === null &&
			!(model.direction === EDiffDirection.History && !model.rightPresent)
		);
	}

	private hunkHintText(model: FileDiffModel): string {
		return hunkHintText({
			model,
			historyChange: this.historyChange,
			against: this.against,
		});
	}

	private async advanceAfterResolve(resolvedPath: string): Promise<void> {
		const next = this.getNextConflictPath(resolvedPath);
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

	private getNextConflictPath(resolvedPath: string): string | null {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		if (!diff) return null;
		return diff.conflicts.find((c) => c.path !== resolvedPath)?.path ?? null;
	}

	private getOrderedPaths(): string[] {
		const diff = this.plugin.controller.getSnapshot().result?.diff;
		if (!diff) return [];
		return [
			...diff.conflicts.map((c) => c.path),
			...diff.localChanges.map((c) => c.path),
			...diff.remoteChanges.map((c) => c.path),
		];
	}

	private getAdjacentPath(
		paths: readonly string[],
		delta: number,
	): string | null {
		if (!this.path) return null;
		const next = paths.indexOf(this.path) + delta;
		return next >= 0 && next < paths.length ? (paths[next] ?? null) : null;
	}

	private async navigateFile(delta: number): Promise<void> {
		// Re-read at click time: the list captured at render goes stale once anything syncs.
		const target = this.getAdjacentPath(this.getOrderedPaths(), delta);
		if (!target) return;
		this.showFile(target);
		await this.refreshModel();
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
