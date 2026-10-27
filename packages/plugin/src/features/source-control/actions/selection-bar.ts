import {
	appendIconButton,
	focusKey,
	renderKeepingFocus,
	textButton,
} from "@/core/ui";

export interface SelectionCommand {
	text: string;
	cta?: boolean;
	run: () => unknown;
}

/** A list whose rows can be ticked. */
export interface SelectionSource {
	readonly selectedCount: number;
	selectionCommands(): SelectionCommand[];
	clearSelection(): void;
}

/** Sticks under the lists while anything is ticked, with what can be done to it in every list at once. */
export class SelectionBar {
	private readonly el: HTMLElement;

	constructor(
		private readonly host: HTMLElement,
		private readonly sources: ReadonlyArray<SelectionSource>,
	) {
		this.el = host.createDiv({ cls: "mdsync-selection-bar" });
		this.el.setAttr("role", "toolbar");
		this.el.setAttr("aria-label", "Selection");
	}

	/** Progress redraws it too: focus stays on the same button. */
	update(busy: boolean): void {
		const { el } = this;
		const focused = el.contains(el.ownerDocument.activeElement);
		renderKeepingFocus(el, () => this.render(busy));
		// A running command locks: the focus waits on Clear selection, which stays enabled.
		if (focused && !el.contains(el.ownerDocument.activeElement))
			el.querySelector<HTMLElement>(".mdsync-row-action")?.focus();
	}

	private render(busy: boolean): void {
		const { el } = this;
		const sources = this.sources;
		el.empty();
		const count = sources.reduce((sum, s) => sum + s.selectedCount, 0);
		el.toggleClass("mdsync-hidden", count === 0);
		// For the phone's one bottom bar: Push and Pull step aside.
		this.host.toggleClass("has-selection", count > 0);
		if (count === 0) return;
		el.createSpan({
			cls: "mdsync-selection-count",
			text: `${count.toLocaleString()} selected`,
		});
		const buttons = el.createDiv({ cls: "mdsync-selection-buttons" });
		const commands = sources.flatMap((s) => s.selectionCommands());
		for (const [index, { text, cta, run }] of commands.entries()) {
			const button = textButton(buttons, text)
				.setDisabled(busy)
				.onClick(() => void run());
			if (cta) button.setCta();
			focusKey(button.buttonEl, `command-${index}`);
		}
		const clear = appendIconButton(buttons, "x", "Clear selection", () => {
			for (const source of sources) source.clearSelection();
		});
		focusKey(clear, "clear").addClass("mdsync-row-action");
	}
}
