import type { App } from "obsidian";
import { openConfirmModal } from "@/core/ui";

/** False when the person keeps unsaved work on screen: merge edits, or changes picked and not applied. */
export function confirmLeave(
	app: App,
	work: { mergeEdits: boolean; picked: number },
): Promise<boolean> {
	if (work.mergeEdits) {
		return openConfirmModal({
			app,
			title: "Discard this merge?",
			body: ["The merged result is not saved. Leaving drops your edits to it."],
			confirmLabel: "Discard",
			cancelLabel: "Keep merging",
			confirmClass: "mod-warning",
		});
	}
	if (work.picked === 0) return Promise.resolve(true);
	const one = work.picked === 1;
	return openConfirmModal({
		app,
		title: "Discard your choices?",
		body: [
			`${work.picked} picked ${one ? "change is" : "changes are"} not applied yet. Leaving drops ${one ? "it" : "them"}.`,
		],
		confirmLabel: "Discard",
		cancelLabel: "Keep choosing",
		confirmClass: "mod-warning",
	});
}
