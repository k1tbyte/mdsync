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

/**
 * Classes for what the header and the bar hold, kept as their writers fill them: `:has` would restyle on
 * any change in the tree. Only these two small trees are watched, never the editors.
 */
export function watchDiffChrome(
	header: HTMLElement,
	bar: HTMLElement,
): MutationObserver {
	const holds = (el: HTMLElement, selector: string): boolean =>
		el.querySelector(selector) !== null;
	// classList.toggle leaves an unchanged class alone: no mutation, no loop.
	const mark = (): void => {
		header.classList.toggle(
			"has-layout",
			holds(header, ".mdsync-segments:not([hidden])"),
		);
		header.classList.toggle(
			"is-resolving",
			holds(header, ".mdsync-diff-resolution") ||
				holds(bar, ".mdsync-diff-resolution"),
		);
		bar.classList.toggle("has-button", holds(bar, "button"));
		bar.classList.toggle("has-hint", holds(bar, ".mdsync-diff-hint"));
		bar.classList.toggle("has-reason", holds(bar, ".is-non-actionable"));
		bar.classList.toggle(
			"has-choices",
			holds(bar, ".mdsync-compare-pending.has-pending"),
		);
		bar.classList.toggle(
			"has-pending-items",
			holds(bar, ".mdsync-compare-pending > *"),
		);
	};
	const observer = new MutationObserver(mark);
	for (const el of [header, bar]) {
		observer.observe(el, {
			childList: true,
			subtree: true,
			attributeFilter: ["class", "hidden"],
		});
	}
	mark();
	return observer;
}
