import { loadMathJax } from "obsidian";

const TEX = "data-mdsync-tex";
const DISPLAY = "data-mdsync-display";

interface MathOptions {
	display?: boolean;
}

/** MathJax 3 as Obsidian bundles it (checked on 1.13: 3.2.2); it has no types of its own. */
interface MathJaxGlobal {
	tex2chtml?: (source: string, options?: MathOptions) => Element;
	tex2chtmlPromise?: (
		source: string,
		options?: MathOptions,
	) => Promise<Element>;
	tex2mml?: (source: string, options?: MathOptions) => string;
}

/** The main window's: the global Obsidian's own renderer calls, whichever window is active. */
const mathJax = (): MathJaxGlobal | undefined =>
	(window as unknown as { MathJax?: MathJaxGlobal }).MathJax;

let tagging = 0;
let undo: (() => void) | null = null;

/**
 * Obsidian draws math as MathJax's own markup and keeps no TeX in it, so the source is tagged on each node as it
 * is made. Returns the release; tagging stays on while any caller holds it.
 */
export async function tagMathSources(markdown: string): Promise<() => void> {
	if (markdown.includes("$")) await loadMathJax();
	const mj = mathJax();
	if (!mj) return () => {};
	if (tagging++ === 0) undo = patch(mj);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--tagging === 0) {
			undo?.();
			undo = null;
		}
	};
}

function patch(mj: MathJaxGlobal): () => void {
	const { tex2chtml, tex2chtmlPromise } = mj;
	const tag = (
		source: string,
		options: MathOptions | undefined,
		node: Element,
	) => {
		node.setAttribute(TEX, source);
		if (options?.display) node.setAttribute(DISPLAY, "");
		return node;
	};
	if (tex2chtml) {
		mj.tex2chtml = (source, options) =>
			tag(source, options, tex2chtml.call(mj, source, options));
	}
	if (tex2chtmlPromise) {
		mj.tex2chtmlPromise = async (source, options) =>
			tag(source, options, await tex2chtmlPromise.call(mj, source, options));
	}
	return () => {
		if (tex2chtml) mj.tex2chtml = tex2chtml;
		if (tex2chtmlPromise) mj.tex2chtmlPromise = tex2chtmlPromise;
	};
}

/**
 * Swaps MathJax's styled markup for plain MathML, which the viewer's browser draws itself: no stylesheet and no
 * fonts travel with the link. A formula MathJax cannot convert stays as its TeX.
 */
export function mathToMathML(root: HTMLElement): void {
	const mj = mathJax();
	const parser = new DOMParser();
	for (const node of Array.from(root.querySelectorAll(`[${TEX}]`))) {
		const source = node.getAttribute(TEX) ?? "";
		const display = node.hasAttribute(DISPLAY);
		const mml = convert(mj, source, display, parser);
		if (mml) {
			node.replaceWith(mml);
		} else {
			const code = root.ownerDocument.createElement("code");
			code.textContent = source;
			node.replaceWith(code);
		}
	}
}

function convert(
	mj: MathJaxGlobal | undefined,
	source: string,
	display: boolean,
	parser: DOMParser,
): Element | null {
	try {
		const markup = mj?.tex2mml?.(source, { display });
		if (!markup) return null;
		const math = parser.parseFromString(markup, "text/html").body
			.firstElementChild;
		return math?.localName === "math" ? math : null;
	} catch {
		return null;
	}
}
