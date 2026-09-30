export type Listener = (event: Record<string, unknown>) => void;

interface ElementOptions {
	cls?: string;
	text?: string;
	type?: string;
	attr?: Record<string, string>;
}

export class FakeEl {
	static active: FakeEl | null = null;

	children: FakeEl[] = [];
	classes = new Set<string>();
	attrs = new Map<string, string>();
	listeners = new Map<string, Listener[]>();
	text = "";
	value = "";
	type = "";
	readOnly = false;
	disabled = false;
	isConnected = true;
	parent: FakeEl | null = null;
	style: Record<string, string> = {};

	constructor(readonly tag: string) {}

	createEl(tag: string, options: ElementOptions = {}): FakeEl {
		const child = new FakeEl(tag);
		if (options.cls) this.addClassNames(child, options.cls);
		for (const [name, value] of Object.entries(options.attr ?? {})) {
			child.attrs.set(name, value);
		}
		child.text = options.text ?? "";
		child.type = options.type ?? "";
		return this.appendChild(child);
	}

	appendChild(child: FakeEl): FakeEl {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	remove(): void {
		this.parent?.children.splice(this.parent.children.indexOf(this), 1);
		this.parent = null;
		this.dropFocusInside();
	}

	contains(node: unknown): boolean {
		return node === this || this.children.some((child) => child.contains(node));
	}

	set className(names: string) {
		for (const name of names.split(" ")) this.classes.add(name);
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	getBoundingClientRect(): { width: number; height: number } {
		return { width: 200, height: 100 };
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((each) => each !== listener),
		);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.length ?? 0;
	}

	createDiv(options: ElementOptions = {}): FakeEl {
		return this.createEl("div", options);
	}

	createSpan(options: ElementOptions = {}): FakeEl {
		return this.createEl("span", options);
	}

	empty(): void {
		const removed = this.children;
		this.children = [];
		this.text = "";
		if (removed.some((child) => child.contains(FakeEl.active))) {
			FakeEl.active = null;
		}
	}

	addClass(...names: string[]): void {
		for (const name of names) this.classes.add(name);
	}

	hasClass(name: string): boolean {
		return this.classes.has(name);
	}

	setText(text: string): void {
		this.text = text;
	}

	setCssProps(props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) {
			this.attrs.set(name, value);
		}
	}

	toggleClass(name: string, on: boolean): void {
		if (on) this.classes.add(name);
		else this.classes.delete(name);
	}

	removeClass(...names: string[]): void {
		for (const name of names) this.classes.delete(name);
	}

	querySelector(selector: string): FakeEl | null {
		const attribute = /^\[([\w-]+)="(.*)"\]$/.exec(selector);
		if (attribute) {
			const [, name, value] = attribute;
			return this.find((el) => el.attrs.get(name ?? "") === value)[0] ?? null;
		}
		if (!selector.startsWith(".")) return null;
		const name = selector.slice(1);
		return this.find((el) => el.hasClass(name))[0] ?? null;
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	get ownerDocument(): { activeElement: FakeEl | null } {
		return {
			get activeElement() {
				return FakeEl.active;
			},
		};
	}

	scrollIntoView(): void {}

	focus(): void {
		if (!this.disabled) FakeEl.active = this;
	}

	setAttr(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	addEventListener(type: string, listener: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	fire(
		type: string,
		event: Record<string, unknown> = {},
	): Record<string, unknown> {
		let stopped = false;
		const dispatched: Record<string, unknown> = {
			defaultPrevented: false,
			preventDefault: () => {
				dispatched.defaultPrevented = true;
			},
			stopPropagation: () => {},
			stopImmediatePropagation: () => {
				stopped = true;
			},
			...event,
		};
		for (const listener of this.listeners.get(type) ?? []) {
			listener(dispatched);
			if (stopped) break;
		}
		return dispatched;
	}

	get textContent(): string {
		return this.text + this.children.map((child) => child.textContent).join("");
	}

	find(match: (el: FakeEl) => boolean): FakeEl[] {
		return this.children.flatMap((child) => [
			...(match(child) ? [child] : []),
			...child.find(match),
		]);
	}

	private dropFocusInside(): void {
		if (this.contains(FakeEl.active)) FakeEl.active = null;
	}

	private addClassNames(target: FakeEl, cls: string): void {
		for (const name of cls.split(" ")) target.classes.add(name);
	}
}

export class FakeDocument extends FakeEl {
	body = new FakeEl("body");

	constructor() {
		super("document");
	}

	createElement(tag: string): FakeEl {
		return new FakeEl(tag);
	}
}
