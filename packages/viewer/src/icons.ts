import { el } from "./dom";

const SVG = "http://www.w3.org/2000/svg";

/** Lucide outlines as path data. */
const ICONS = {
	"file-text": [
		"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
		"M14 2v4a2 2 0 0 0 2 2h4",
		"M10 9H8",
		"M16 13H8",
		"M16 17H8",
	],
	eye: [
		"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
		"M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
	],
	clock: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M12 6v6l4 2"],
	"move-horizontal": ["m18 8 4 4-4 4", "M2 12h20", "m6 8-4 4 4 4"],
	copy: [
		"M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
		"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
	],
	menu: ["M4 12h16", "M4 6h16", "M4 18h16"],
	x: ["M18 6 6 18", "m6 6 12 12"],
	github: [
		"M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
		"M9 18c-4.51 2-5-2-7-2",
	],
	lock: [
		"M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
		"M7 11V7a5 5 0 0 1 10 0v4",
	],
	"circle-alert": [
		"M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0",
		"M12 8v4",
		"M12 16h.01",
	],
	hourglass: [
		"M5 22h14",
		"M5 2h14",
		"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22",
		"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
	],
	unlink: [
		"M9 17H7A5 5 0 0 1 7 7",
		"M15 7h2a5 5 0 0 1 4 8",
		"M8 12h4",
		"M2 2l20 20",
	],
	"triangle-alert": [
		"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
		"M12 9v4",
		"M12 17h.01",
	],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof ICONS;

export function icon(doc: Document, name: IconName): SVGSVGElement {
	const svg = doc.createElementNS(SVG, "svg");
	const attrs = {
		class: "icon",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	};
	for (const [key, value] of Object.entries(attrs))
		svg.setAttribute(key, value);
	for (const d of ICONS[name]) {
		const path = doc.createElementNS(SVG, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

/** An icon and a label; a narrow screen may hide the label, which still names the button. */
export function button(
	doc: Document,
	cls: string,
	name: IconName,
	label: string,
): HTMLButtonElement {
	return el(
		doc,
		"button",
		{ type: "button", class: cls },
		icon(doc, name),
		el(doc, "span", { class: "label" }, label),
	);
}

/** The square tile an icon sits in: the page's mark, a gate's lock, a message's sign. */
export function tile(doc: Document, cls: string, name: IconName): HTMLElement {
	return el(doc, "span", { class: `tile ${cls}` }, icon(doc, name));
}

/** "Shared with MDSync" and where it comes from, at the foot of every page. */
export function credit(doc: Document): HTMLElement {
	return el(
		doc,
		"footer",
		{ class: "credit" },
		el(doc, "span", {}, "Shared with MDSync"),
		el(
			doc,
			"a",
			{
				href: "https://github.com/k1tbyte/mdsync",
				"aria-label": "MDSync on GitHub",
				rel: "noopener",
			},
			icon(doc, "github"),
		),
	);
}
