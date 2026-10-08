import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * The note as Markdown, made from the sanitized page rather than from the author's file, so nothing the
 * snapshot dropped (properties, comments, vault links) can come back. Vault images have no Markdown form here.
 */
export function noteMarkdown(title: string, body: DocumentFragment): string {
	const markdown = service.turndown(body).trim();
	return title ? `# ${title}\n\n${markdown}\n` : `${markdown}\n`;
}

const service = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});
service.use(gfm);
// Mermaid drawings and callout icons.
service.remove((node) => node.localName === "svg");

// The library pads a marker to four columns ("-   item", "[x]  item"); this is the usual one space.
service.addRule("listItem", {
	filter: "li",
	replacement: (content, item, options) => {
		const list = item.parentElement;
		const marker =
			list?.localName === "ol"
				? `${Number(list.getAttribute("start") ?? 1) + Array.from(list.children).indexOf(item)}.`
				: (options.bulletListMarker ?? "-");
		const text = content
			.replace(/^\n+/, "")
			.replace(/\n+$/, "\n")
			.replace(/^(\[[ x]\])\s+/, "$1 ");
		const indented = text.replace(
			/\n(?!$)/g,
			`\n${" ".repeat(marker.length + 1)}`,
		);
		const more = item.nextElementSibling && !text.endsWith("\n") ? "\n" : "";
		return `${marker} ${indented}${more}`;
	},
});

service.addRule("math", {
	filter: (node) => node.localName === "math",
	replacement: (_content, math) => {
		const tex = math.getAttribute("data-tex") ?? math.textContent ?? "";
		return math.getAttribute("display") === "block"
			? `\n\n$$\n${tex}\n$$\n\n`
			: `$${tex}$`;
	},
});

service.addRule("callout", {
	filter: (node) => node.classList.contains("callout"),
	replacement: (_content, callout) => {
		const type = callout.getAttribute("data-callout") ?? "note";
		const title =
			callout.querySelector(".callout-title-inner")?.textContent?.trim() ?? "";
		const content = callout.querySelector<HTMLElement>(".callout-content");
		const lines = [
			`[!${type}]${foldMark(callout)}${title ? ` ${title}` : ""}`,
			...(content ? service.turndown(content).trim().split("\n") : []),
		];
		return `\n\n${lines.map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
	},
});

/** Obsidian's `+` (open) and `-` (folded) after a collapsible callout's type. */
function foldMark(callout: HTMLElement): string {
	if (!callout.classList.contains("is-collapsible")) return "";
	return callout.classList.contains("is-collapsed") ? "-" : "+";
}

service.addRule("inlinedImage", {
	filter: (node) =>
		node.localName === "img" &&
		(node.getAttribute("src") ?? "").startsWith("data:"),
	replacement: () => "",
});
