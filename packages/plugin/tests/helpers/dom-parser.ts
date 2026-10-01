interface Node {
	local: string;
	text: string;
	children: Node[];
}

const TOKEN = /<\?[\s\S]*?\?>|<(\/?)(?:[\w-]+:)?([\w-]+)[^>]*?(\/?)>|([^<]+)/g;
const ENTITIES: Record<string, string> = {
	"&quot;": '"',
	"&lt;": "<",
	"&gt;": ">",
	"&amp;": "&",
};

/** Just enough of the browser's XML parser for the WebDAV listing tests: the node runner has none. */
export class FakeDOMParser {
	parseFromString(xml: string) {
		const root: Node = { local: "", text: "", children: [] };
		const open = [root];
		for (const [token, closing, local, selfClosing, text] of tokens(xml)) {
			const top = open[open.length - 1] as Node;
			if (text !== undefined) top.text += decode(text);
			else if (local && closing) open.pop();
			else if (local) {
				const node: Node = { local, text: "", children: [] };
				top.children.push(node);
				if (!selfClosing) open.push(node);
			} else if (!token.startsWith("<?")) throw new Error("bad xml");
		}
		return wrap(root);
	}
}

function tokens(xml: string) {
	return [...xml.matchAll(TOKEN)].map(
		(match) => [...match] as [string, string, string, string, string],
	);
}

function decode(text: string): string {
	return text.replace(/&\w+;/g, (entity) => ENTITIES[entity] ?? entity);
}

function textOf(node: Node): string {
	return node.text + node.children.map(textOf).join("");
}

function descendants(node: Node, local: string): Node[] {
	return node.children.flatMap((child) => [
		...(child.local === local ? [child] : []),
		...descendants(child, local),
	]);
}

function wrap(node: Node) {
	return {
		textContent: textOf(node),
		getElementsByTagName(local: string) {
			return { length: descendants(node, local).length };
		},
		getElementsByTagNameNS(_ns: string, local: string) {
			const found = descendants(node, local).map(wrap);
			return { length: found.length, item: (index: number) => found[index] };
		},
	};
}
