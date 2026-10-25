import type { FileDiffModel } from "@/sync/projection";

const CONFLICT_PREVIEW_LINES = 10;

const LINE_CLASSES: Record<string, string> = { "+": "is-add", "-": "is-del" };

/** All the preview renders of a diff: the model holds every side's full text. */
export interface ConflictPreview {
	binary: boolean;
	lines: string[];
	/** Lines beyond `lines`. */
	remaining: number;
}

export function summarizeConflictPreview(
	model: FileDiffModel,
): ConflictPreview {
	const lines: string[] = [];
	let total = 0;
	for (const hunk of model.hunks.hunks) {
		total += hunk.lines.length;
		for (const line of hunk.lines) {
			if (lines.length < CONFLICT_PREVIEW_LINES) lines.push(line);
		}
	}
	return {
		binary: model.isBinary,
		lines,
		remaining: total - lines.length,
	};
}

export function renderConflictPreview(
	parent: HTMLElement,
	{ lines, remaining }: ConflictPreview,
): void {
	if (lines.length === 0) {
		parent.createEl("p", {
			cls: "mdsync-conflict-preview-empty",
			text: "No textual differences.",
		});
		return;
	}

	const pre = parent.createEl("pre", { cls: "mdsync-conflict-preview-diff" });
	for (const line of lines) {
		const cls = LINE_CLASSES[line[0] ?? ""] ?? "";
		const span = pre.createSpan({ cls: `mdsync-unified-line ${cls}` });
		span.createSpan({ cls: "mdsync-line-prefix", text: line[0] ?? " " });
		span.createSpan({ text: line.slice(1) });
	}
	if (remaining > 0) {
		parent.createEl("p", {
			cls: "mdsync-conflict-preview-more",
			text: `… ${remaining} more line(s) — open diff view for full details`,
		});
	}
}
