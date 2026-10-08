/** Where the viewer makes elements and tells them apart, so no other file needs `createElement` or `instanceof`. */

type Child = Node | string;

export function el<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	attrs: Record<string, string> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		node.setAttribute(name, value);
	}
	node.append(...children);
	return node;
}

export function isElement(node: Node): node is Element {
	return node.nodeType === Node.ELEMENT_NODE;
}

export function isTag<K extends keyof HTMLElementTagNameMap>(
	node: Node,
	tag: K,
): node is HTMLElementTagNameMap[K] {
	return isElement(node) && node.localName === tag;
}

export function isHeading(node: Node): node is HTMLHeadingElement {
	return isElement(node) && /^h[1-6]$/.test(node.localName);
}
