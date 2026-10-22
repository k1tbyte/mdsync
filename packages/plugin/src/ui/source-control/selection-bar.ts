import { appendIconButton } from "@/ui/common";
import { textButton } from "./action-button";
import type { ChangesSection } from "./changes-section";

/** Sticks under the lists while anything is ticked, with what can be done to it in every section at once. */
export class SelectionBar {
	private readonly el: HTMLElement;

	constructor(
		parent: HTMLElement,
		private readonly sections: ReadonlyArray<ChangesSection>,
	) {
		this.el = parent.createDiv({ cls: "mdsync-selection-bar" });
		this.el.setAttr("role", "toolbar");
		this.el.setAttr("aria-label", "Selection");
	}

	update(busy: boolean): void {
		const { el } = this;
		const sections = this.sections;
		el.empty();
		const count = sections.reduce((sum, s) => sum + s.selectedCount, 0);
		el.toggleClass("mdsync-hidden", count === 0);
		if (count === 0) return;
		el.createSpan({
			cls: "mdsync-selection-count",
			text: `${count.toLocaleString()} selected`,
		});
		const buttons = el.createDiv({ cls: "mdsync-selection-buttons" });
		for (const { text, cta, run } of sections.flatMap((s) =>
			s.selectionCommands(),
		)) {
			const button = textButton(buttons, text)
				.setDisabled(busy)
				.onClick(() => void run());
			if (cta) button.setCta();
		}
		appendIconButton(buttons, "x", "Clear selection", () => {
			for (const section of sections) section.clearSelection();
		}).addClass("mdsync-row-action");
	}
}
