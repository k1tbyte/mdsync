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

export class Notice extends Stub {}
export class Modal extends Stub {}
export class Plugin extends Stub {}
export class PluginSettingTab extends Stub {
	hide(): void {}
}
export class Setting extends Stub {}
export class ButtonComponent extends Stub {}
export class ItemView extends Stub {}
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
