/** Obsidian's `ButtonComponent` over a real `<button>`, for jsdom tests that click pagers and footers. */
export class DomButtonComponent {
	readonly buttonEl: HTMLButtonElement;
	disabled = false;

	constructor(parent: HTMLElement) {
		this.buttonEl = parent.createEl("button") as HTMLButtonElement;
	}

	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		this.buttonEl.disabled = disabled;
		return this;
	}

	onClick(fn: () => void): this {
		this.buttonEl.addEventListener("click", fn);
		return this;
	}
}
