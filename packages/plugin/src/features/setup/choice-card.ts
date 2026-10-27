import { setIcon } from "obsidian";

export interface ChoiceCardOptions {
	icon: string;
	title: string;
	desc: string;
	badge?: string;
	/** The way most people take: its icon is filled with the accent. */
	primary?: boolean;
	onClick: () => void;
}

/** A whole-row button for picking one way forward. */
export function choiceCard(
	parent: HTMLElement,
	options: ChoiceCardOptions,
): HTMLButtonElement {
	const card = parent.createEl("button", { cls: "mdsync-choice" });
	card.type = "button";
	if (options.primary) card.addClass("is-primary");
	setIcon(card.createSpan({ cls: "mdsync-choice-icon" }), options.icon);
	const text = card.createDiv({ cls: "mdsync-choice-text" });
	const title = text.createDiv({
		cls: "mdsync-choice-title",
		text: options.title,
	});
	if (options.badge) {
		title.createSpan({ cls: "mdsync-choice-badge", text: options.badge });
	}
	text.createDiv({ cls: "mdsync-choice-desc", text: options.desc });
	setIcon(card.createSpan({ cls: "mdsync-choice-arrow" }), "chevron-right");
	card.addEventListener("click", options.onClick);
	return card;
}
