import { FakeEl } from "./fake-dom";

export { FakeDocument, FakeEl } from "./fake-dom";

export class FakeModal {
	titleEl = new FakeEl("h2");
	contentEl = new FakeEl("div");
	modalEl = new FakeEl("div");
	containerEl = new FakeEl("div");

	constructor(readonly app: unknown) {
		this.modalEl.children.push(this.titleEl, this.contentEl);
	}

	onOpen(): void {}
	onClose(): void {}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}
}

export class FakeButton {
	readonly buttonEl: FakeEl;

	constructor(parent: FakeEl) {
		this.buttonEl = parent.createEl("button");
	}

	setButtonText(text: string): this {
		this.buttonEl.text = text;
		return this;
	}

	setWarning(): this {
		this.buttonEl.addClass("mod-warning");
		return this;
	}

	setCta(): this {
		this.buttonEl.addClass("mod-cta");
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}

	onClick(handler: () => unknown): this {
		this.buttonEl.addEventListener("click", () => void handler());
		return this;
	}
}

class FakeExtraButton extends FakeButton {
	setIcon(icon: string): this {
		this.buttonEl.setAttr("data-icon", icon);
		return this;
	}

	setTooltip(label: string): this {
		this.buttonEl.setAttr("aria-label", label);
		return this;
	}
}

class FakeText {
	readonly inputEl: FakeEl;

	constructor(parent: FakeEl) {
		this.inputEl = parent.createEl("input", { type: "text" });
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	onChange(handler: (value: string) => void): this {
		this.inputEl.addEventListener("input", () => handler(this.inputEl.value));
		return this;
	}
}

class FakeToggle {
	readonly toggleEl: FakeEl;
	readonly inputEl: FakeEl;
	private on = false;

	constructor(parent: FakeEl) {
		this.toggleEl = parent.createEl("label", { cls: "checkbox-container" });
		this.inputEl = this.toggleEl.createEl("input", { type: "checkbox" });
	}

	setValue(value: boolean): this {
		this.on = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.inputEl.disabled = disabled;
		return this;
	}

	onChange(handler: (value: boolean) => void): this {
		this.toggleEl.addEventListener("click", () => {
			if (this.inputEl.disabled) return;
			this.on = !this.on;
			handler(this.on);
		});
		return this;
	}
}

export class FakeSetting {
	readonly settingEl: FakeEl;
	private readonly nameEl: FakeEl;
	private readonly descEl: FakeEl;
	private readonly controlEl: FakeEl;

	constructor(parent: FakeEl) {
		this.settingEl = parent.createDiv({ cls: "setting-item" });
		const info = this.settingEl.createDiv({ cls: "setting-item-info" });
		this.nameEl = info.createDiv({ cls: "setting-item-name" });
		this.descEl = info.createDiv({ cls: "setting-item-description" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}

	setName(name: string | FakeEl): this {
		if (typeof name === "string") this.nameEl.text = name;
		else this.nameEl.children.push(name);
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.text = desc;
		return this;
	}

	addButton(configure: (button: FakeButton) => unknown): this {
		configure(new FakeButton(this.controlEl));
		return this;
	}

	addExtraButton(configure: (button: FakeExtraButton) => unknown): this {
		configure(new FakeExtraButton(this.controlEl));
		return this;
	}

	addText(configure: (text: FakeText) => unknown): this {
		configure(new FakeText(this.controlEl));
		return this;
	}

	addToggle(configure: (toggle: FakeToggle) => unknown): this {
		configure(new FakeToggle(this.controlEl));
		return this;
	}
}

export function fakeObsidian<Original extends object>(original: Original) {
	return {
		...original,
		Modal: FakeModal,
		Setting: FakeSetting,
		ButtonComponent: FakeButton,
	};
}
