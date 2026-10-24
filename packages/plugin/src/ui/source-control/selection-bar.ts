import { appendIconButton } from "@/ui/common";
import { textButton } from "./action-button";

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
		parent: HTMLElement,
		private readonly sources: ReadonlyArray<SelectionSource>,
	) {
		this.el = parent.createDiv({ cls: "mdsync-selection-bar" });
		this.el.setAttr("role", "toolbar");
		this.el.setAttr("aria-label", "Selection");
	}

	update(busy: boolean): void {
		const { el } = this;
		const sources = this.sources;
		el.empty();
		const count = sources.reduce((sum, s) => sum + s.selectedCount, 0);
		el.toggleClass("mdsync-hidden", count === 0);
		if (count === 0) return;
		el.createSpan({
			cls: "mdsync-selection-count",
			text: `${count.toLocaleString()} selected`,
		});
		const buttons = el.createDiv({ cls: "mdsync-selection-buttons" });
		for (const { text, cta, run } of sources.flatMap((s) =>
			s.selectionCommands(),
		)) {
			const button = textButton(buttons, text)
				.setDisabled(busy)
				.onClick(() => void run());
			if (cta) button.setCta();
		}
		appendIconButton(buttons, "x", "Clear selection", () => {
			for (const source of sources) source.clearSelection();
		}).addClass("mdsync-row-action");
	}
}
