import type { FileDiffModel } from "@/sync/projection";

const CONFLICT_PREVIEW_LINES = 10;

const LINE_CLASSES: Record<string, string> = { "+": "is-add", "-": "is-del" };

export function renderConflictPreview(
	parent: HTMLElement,
	model: FileDiffModel,
): void {
	const hunks = model.hunks.hunks;
	if (hunks.length === 0) {
		parent.createEl("p", {
			cls: "obsync-conflict-preview-empty",
			text: "No textual differences.",
		});
		return;
	}

	const pre = parent.createEl("pre", { cls: "obsync-conflict-preview-diff" });
	let linesShown = 0;
	outer: for (const hunk of hunks) {
		for (const line of hunk.lines) {
			const cls = LINE_CLASSES[line[0] ?? ""] ?? "";
			const span = pre.createSpan({ cls: `obsync-unified-line ${cls}` });
			span.createSpan({ cls: "obsync-line-prefix", text: line[0] ?? " " });
			span.createSpan({ text: line.slice(1) });
			linesShown++;
			if (linesShown >= CONFLICT_PREVIEW_LINES) break outer;
		}
	}
	const remaining = hunks.reduce((n, h) => n + h.lines.length, 0) - linesShown;
	if (remaining > 0) {
		parent.createEl("p", {
			cls: "obsync-conflict-preview-more",
			text: `… ${remaining} more line(s) — open diff view for full details`,
		});
	}
}
