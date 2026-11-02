import { appendIconButton, appendLabeledButton } from "@/core/ui";
import type { PanelHosts } from "../header";
import { renderChangeNav } from "../rail";

export interface MergeProgress {
	/** Changes still waiting for a side. */
	unresolved: number;
	total: number;
	/** The selected change's position, or -1. */
	current: number;
	canUndo: boolean;
	canRedo: boolean;
	versionsChanged: boolean;
}

/** The merge's parts of the diff frame; built once per render and moved into each new frame. */
export class MergeToolbar {
	readonly info = createSpan({ cls: "mdsync-merge-info" });
	readonly controls = createDiv({ cls: "mdsync-compare-controls" });
	private readonly status: HTMLButtonElement;
	private history: HTMLButtonElement[] = [];
	private showPosition: ((current: number, total: number) => void) | null =
		null;
	private save: HTMLButtonElement | null = null;
	private unresolved = 0;

	private readonly changed: HTMLElement;

	constructor(nextConflict: () => void) {
		this.status = appendLabeledButton(this.info, "", "", nextConflict);
		this.status.addClasses(["mdsync-diff-status", "mdsync-merge-status"]);
		this.status.setAttr("aria-description", "Goes to the next conflict");
		this.changed = this.info.createSpan({
			cls: "mdsync-merge-changed",
			text: "File changed",
			attr: {
				"aria-label":
					"This file changed since the merge opened, so Save will be refused",
			},
		});
	}

	mount(hosts: PanelHosts): void {
		hosts.info.appendChild(this.info);
		hosts.controls.appendChild(this.controls);
		this.save = hosts.save;
		this.showSave();
	}

	undoRedo(undo: () => void, redo: () => void): void {
		this.controls.createSpan({ cls: "mdsync-diff-separator" });
		this.history = [
			appendIconButton(this.controls, "undo-2", "Undo", undo),
			appendIconButton(this.controls, "redo-2", "Redo", redo),
		];
	}

	navigation(jump: (delta: number) => void): void {
		this.showPosition = renderChangeNav(this.controls, jump);
	}

	update(progress: MergeProgress): void {
		const { unresolved, total, current } = progress;
		const merged = total - unresolved;
		this.status.lastElementChild?.setText(
			unresolved > 0
				? `${unresolved} ${unresolved === 1 ? "conflict" : "conflicts"} left · ${merged} merged`
				: `${total} ${total === 1 ? "change" : "changes"} merged`,
		);
		this.status.toggleClass("is-conflict", unresolved > 0);
		this.status.toggleClass("is-resolved", unresolved === 0);
		this.status.disabled = unresolved === 0;
		const [undo, redo] = this.history;
		if (undo) undo.disabled = !progress.canUndo;
		if (redo) redo.disabled = !progress.canRedo;
		this.showPosition?.(current, total);
		this.changed.hidden = !progress.versionsChanged;
		this.unresolved = unresolved;
		this.showSave();
	}

	/** Still pressable: it says what is left rather than doing nothing. */
	private showSave(): void {
		this.save?.setAttr("aria-disabled", String(this.unresolved > 0));
	}
}
