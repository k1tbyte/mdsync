interface ElementOptions {
	text?: string;
	cls?: string;
}

/** Obsidian's global element factories, which jsdom lacks. */
export function installElementFactories(): void {
	const createEl = (tag: string, options: ElementOptions = {}) => {
		const node = document.createElement(tag);
		if (options.text !== undefined) node.textContent = options.text;
		if (options.cls) node.className = options.cls;
		return node;
	};
	Object.assign(globalThis, {
		createEl,
		createSpan: (options?: ElementOptions) => createEl("span", options),
	});
}
