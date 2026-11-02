// Minimal obsidian runtime stub for vitest. The real package ships no usable entry outside Obsidian.

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isMacOS: false,
	isWin: true,
	isLinux: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
};

export function debounce<T extends (...args: unknown[]) => unknown>(fn: T): T {
	// Obsidian returns a debouncer; callers cancel it on unload.
	return Object.assign(fn, { cancel: () => undefined, run: () => undefined });
}

export function requestUrl(): Promise<unknown> {
	return Promise.resolve({
		status: 200,
		json: {},
		text: "",
		arrayBuffer: new ArrayBuffer(0),
	});
}

export function normalizePath(path: string): string {
	return path;
}

export function setIcon(_el: unknown, _icon: string): void {}

export function loadMathJax(): Promise<void> {
	return Promise.resolve();
}

class Stub {}

/** What a component draws into under node, where there is no DOM: it takes the calls and keeps nothing. */
class InertElement {
	textContent = "";
	disabled = false;
	classList = { add: () => undefined };
	addEventListener(): void {}
	addClass(): void {}
	empty(): void {}
	createDiv(): InertElement {
		return new InertElement();
	}
}

function element(parent?: unknown, tag = "div"): HTMLElement {
	if (typeof document === "undefined") {
		return new InertElement() as unknown as HTMLElement;
	}
	const node = document.createElement(tag);
	if (parent instanceof HTMLElement) parent.appendChild(node);
	return node;
}

export class Notice extends Stub {}
export class Modal extends Stub {
	readonly containerEl = element();
	readonly modalEl = element(this.containerEl);
	readonly titleEl = element(this.modalEl);
	readonly contentEl = element(this.modalEl);
	constructor(readonly app: unknown) {
		super();
	}
	open(): void {}
	close(): void {}
}
export class Plugin extends Stub {}
export class PluginSettingTab extends Stub {
	hide(): void {}
}

/** Obsidian's button over a real `<button>`; `click` is the handler, for a test that awaits it. */
export class ButtonComponent extends Stub {
	readonly buttonEl: HTMLButtonElement;
	text = "";
	disabled = false;
	click: () => unknown = () => undefined;
	constructor(containerEl?: unknown) {
		super();
		this.buttonEl = element(containerEl, "button") as HTMLButtonElement;
	}
	setButtonText(text: string): this {
		this.text = text;
		this.buttonEl.textContent = text;
		return this;
	}
	setCta(): this {
		this.buttonEl.classList.add("mod-cta");
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		this.buttonEl.disabled = disabled;
		return this;
	}
	onClick(fn: () => unknown): this {
		this.click = fn;
		this.buttonEl.addEventListener("click", fn);
		return this;
	}
}

/** The icon button of a settings row: its label is the tooltip. */
export class ExtraButtonComponent extends Stub {
	readonly extraSettingsEl: HTMLElement;
	icon = "";
	tooltip = "";
	disabled = false;
	click: () => unknown = () => undefined;
	constructor(containerEl?: unknown) {
		super();
		this.extraSettingsEl = element(containerEl);
		this.extraSettingsEl.classList.add(
			"clickable-icon",
			"extra-setting-button",
		);
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	setTooltip(tooltip: string): this {
		this.tooltip = tooltip;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(fn: () => unknown): this {
		this.click = fn;
		this.extraSettingsEl.addEventListener("click", fn);
		return this;
	}
}

/** A settings row over real elements; `buttons` keeps what was added, for a test to click. */
export class Setting extends Stub {
	name = "";
	desc = "";
	readonly buttons: Array<ButtonComponent | ExtraButtonComponent> = [];
	readonly settingEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	constructor(containerEl?: unknown) {
		super();
		this.settingEl = element(containerEl);
		this.nameEl = element(this.settingEl);
		this.descEl = element(this.settingEl);
		this.controlEl = element(this.settingEl);
	}
	setName(name: string): this {
		this.name = name;
		this.nameEl.textContent = name;
		return this;
	}
	setDesc(desc: string): this {
		this.desc = desc;
		this.descEl.textContent = desc;
		return this;
	}
	addText(build: (text: TextComponent) => unknown): this {
		build(new TextComponent(this.controlEl));
		return this;
	}
	addButton(build: (button: ButtonComponent) => unknown): this {
		const button = new ButtonComponent(this.controlEl);
		this.buttons.push(button);
		build(button);
		return this;
	}
	addExtraButton(build: (button: ExtraButtonComponent) => unknown): this {
		const button = new ExtraButtonComponent(this.controlEl);
		this.buttons.push(button);
		build(button);
		return this;
	}
}
export class Scope {
	register(): void {}
}
export class ItemView extends Stub {
	app = {};
	scope: Scope | null = null;
}
export class FileView extends ItemView {}
export class MarkdownView extends FileView {}
export class Menu extends Stub {}

/** Obsidian's text inputs for DOM tests: an input and its fluent setters. */
class TextInput {
	readonly inputEl: HTMLInputElement;
	constructor(containerEl: HTMLElement) {
		this.inputEl = containerEl.ownerDocument.createElement("input");
		containerEl.appendChild(this.inputEl);
	}
	getValue(): string {
		return this.inputEl.value;
	}
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}
	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
		return this;
	}
}
export class TextComponent extends TextInput {}
export class SearchComponent extends TextInput {}
export class TFile extends Stub {}
export class TFolder extends Stub {}
export class TAbstractFile extends Stub {}

export class FileSystemAdapter extends Stub {
	constructor(private readonly basePath = "") {
		super();
	}
	getBasePath(): string {
		return this.basePath;
	}
}

export type App = unknown;
export type WorkspaceLeaf = unknown;
export type ObsidianProtocolData = unknown;
export type ViewStateResult = unknown;
export type DataAdapter = unknown;
export type ListedFiles = { files: string[]; folders: string[] };
export type Stat = {
	type: "file" | "folder";
	ctime: number;
	mtime: number;
	size: number;
};
