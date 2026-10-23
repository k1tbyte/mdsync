import { ButtonComponent } from "obsidian";
import { EDiffDirection } from "@/sync/projection";
import type { DiffHeaderActions, DiffHeaderState } from "./header";

/** Between the bar and the panes: what Apply will do, why per-change actions are off, whole-file actions. */
export function renderActionBar(
	bar: HTMLElement,
	state: DiffHeaderState & { hint: string },
	actions: DiffHeaderActions,
): HTMLElement {
	bar.empty();
	const pending = bar.createDiv({ cls: "mdsync-diff-pending-host" });
	if (state.isEditing || !state.direction) return pending;
	if (state.hint)
		bar.createSpan({
			cls: "mdsync-diff-hint is-non-actionable",
			text: state.hint,
		});
	const buttons = bar.createDiv({ cls: "mdsync-diff-file-actions" });
	if (state.direction === EDiffDirection.History) {
		new ButtonComponent(buttons)
			.setButtonText(state.restoreLabel ?? "Restore this version")
			.setCta()
			.onClick(actions.restoreVersion);
	} else if (state.direction === EDiffDirection.Conflict) {
		new ButtonComponent(buttons)
			.setButtonText("Keep local")
			.onClick(actions.keepLocal);
		new ButtonComponent(buttons)
			.setButtonText("Accept remote")
			.onClick(actions.acceptRemote);
		if (!state.isBinary) {
			if (state.remotePresent) {
				new ButtonComponent(buttons)
					.setButtonText("Keep both versions")
					.onClick(actions.keepBothVersions);
			}
			new ButtonComponent(buttons)
				.setButtonText("Merge…")
				.setCta()
				.onClick(actions.startMerge);
		}
	}
	return pending;
}
