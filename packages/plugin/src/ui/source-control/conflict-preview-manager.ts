import type { FileDiffModel } from "@/sync/projection";
import {
	type ConflictPreview,
	renderConflictPreview,
	summarizeConflictPreview,
} from "./conflict-preview";

interface ConflictPreviewManagerDeps {
	loadPreview: (path: string) => Promise<FileDiffModel | null>;
}

export class ConflictPreviewManager {
	private readonly loadPreview: (path: string) => Promise<FileDiffModel | null>;
	private readonly previewCache = new Map<string, ConflictPreview | null>();
	private readonly loadingPreviews = new Set<string>();
	private readonly pendingTargets = new Map<string, HTMLElement>();
	private readonly expandedPreviews = new Set<string>();

	constructor(deps: ConflictPreviewManagerDeps) {
		this.loadPreview = deps.loadPreview;
	}

	clearCache(): void {
		this.previewCache.clear();
		this.loadingPreviews.clear();
		this.pendingTargets.clear();
	}

	prune(conflictPaths: ReadonlyArray<string>): void {
		if (this.expandedPreviews.size === 0) return;
		const current = new Set(conflictPaths);
		for (const path of this.expandedPreviews) {
			if (current.has(path)) continue;
			this.expandedPreviews.delete(path);
			this.previewCache.delete(path);
		}
	}

	isExpanded(path: string): boolean {
		return this.expandedPreviews.has(path);
	}

	toggle(path: string): void {
		if (this.expandedPreviews.delete(path)) this.previewCache.delete(path);
		else this.expandedPreviews.add(path);
	}

	render(parent: HTMLElement, path: string): void {
		const previewEl = parent.createDiv({ cls: "mdsync-conflict-preview" });
		const cached = this.previewCache.get(path);
		if (cached !== undefined) {
			this.renderInto(previewEl, cached);
			return;
		}
		previewEl.setText("Loading diff…");
		// The element may be detached by a re-render, so remember and fill the newest one.
		this.pendingTargets.set(path, previewEl);
		if (this.loadingPreviews.has(path)) return;
		this.loadingPreviews.add(path);
		void this.loadPreview(path)
			.then((model) => {
				const preview = model && summarizeConflictPreview(model);
				this.previewCache.set(path, preview);
				this.settle(path, preview);
			})
			.catch(() => {
				// Not cached: a transient failure should be retried on the next open.
				this.settle(path, null);
			});
	}

	private settle(path: string, preview: ConflictPreview | null): void {
		this.loadingPreviews.delete(path);
		const target = this.pendingTargets.get(path);
		this.pendingTargets.delete(path);
		if (target) {
			this.renderInto(target, preview);
		}
	}

	private renderInto(
		previewEl: HTMLElement,
		preview: ConflictPreview | null,
	): void {
		if (!previewEl.isConnected) return;
		previewEl.empty();
		if (preview === null) {
			previewEl.setText("No diff available.");
			return;
		}
		if (preview.binary) {
			previewEl.setText("Binary file — cannot preview diff.");
			return;
		}
		renderConflictPreview(previewEl, preview);
	}
}
