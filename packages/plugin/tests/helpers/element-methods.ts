interface ElementInfo {
	text?: string;
	cls?: string;
	attr?: Record<string, string>;
}

/** The HTMLElement helpers Obsidian adds, which jsdom lacks; only what the setup views use. */
export function installElementMethods(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	function createEl(this: HTMLElement, tag: string, info: ElementInfo = {}) {
		const node = document.createElement(tag);
		if (info.text !== undefined) node.textContent = info.text;
		if (info.cls) node.className = info.cls;
		for (const [key, value] of Object.entries(info.attr ?? {}))
			node.setAttribute(key, value);
		this.appendChild(node);
		return node;
	}
	Object.assign(proto, {
		createEl,
		createDiv(this: HTMLElement, info?: ElementInfo) {
			return createEl.call(this, "div", info);
		},
		createSpan(this: HTMLElement, info?: ElementInfo) {
			return createEl.call(this, "span", info);
		},
		setAttr(this: HTMLElement, key: string, value: string) {
			this.setAttribute(key, value);
		},
		addClass(this: HTMLElement, cls: string) {
			this.classList.add(cls);
		},
		toggleClass(this: HTMLElement, cls: string, on: boolean) {
			this.classList.toggle(cls, on);
		},
		setText(this: HTMLElement, text: string) {
			this.textContent = text;
		},
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [key, value] of Object.entries(props))
				this.style.setProperty(key, value);
		},
		empty(this: HTMLElement) {
			this.replaceChildren();
		},
	});
}
