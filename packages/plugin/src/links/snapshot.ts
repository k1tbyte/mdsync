import { type App, Component, MarkdownRenderer, type TFile } from "obsidian";

import { inlineImage } from "./images";
import { mathToMathML, tagMathSources } from "./math";
import { sanitizeRendered } from "./sanitize";

/** Roughly what a note's own text leaves of the link's size limit. */
const IMAGES_TOTAL_MAX_CHARS = 4 * 1024 * 1024;
const SETTLE_MAX_MS = 5000;
const SETTLE_STEP_MS = 100;
const STEADY_STEPS = 2;

export interface Snapshot {
	html: string;
	/** Milliseconds, just before the note was read. */
	takenAt: number;
	/** Whether the vault's images were inlined. */
	images: boolean;
	/** False when something was still drawing after the wait; the page may show it unfinished. */
	complete: boolean;
	/** What the owner is told was left out of the link. */
	left: { embeds: number; images: number; diagrams: number };
}

/**
 * The note as Obsidian's reading view draws it, made safe to publish. It renders attached to the page, hidden:
 * detached, callout icons stay empty.
 */
export async function takeSnapshot(
	app: App,
	file: TFile,
	markdown: string,
	options: { images: boolean },
): Promise<Omit<Snapshot, "takenAt">> {
	// Before the host exists: a MathJax that fails to load leaves nothing behind.
	const untag = await tagMathSources(markdown);
	const host = activeDocument.body.createDiv({ cls: "mdsync-link-render" });
	const component = new Component();
	component.load();
	try {
		await MarkdownRenderer.render(app, markdown, host, file.path, component);
		const complete = await settled(host);
		mathToMathML(host);
		const report = sanitizeRendered(host);
		const images = options.images
			? await inline(app, file.path, report.images)
			: dropAll(report.images);
		return {
			html: host.innerHTML,
			images: options.images,
			complete,
			left: {
				embeds: report.embedsDropped,
				images: images + report.imagesDropped,
				diagrams: report.mermaidAsSource,
			},
		};
	} finally {
		untag();
		component.unload();
		host.remove();
	}
}

/** Renders asynchronously: math, embeds and images arrive after `render` resolves. False when time ran out. */
async function settled(host: HTMLElement): Promise<boolean> {
	const deadline = Date.now() + SETTLE_MAX_MS;
	let last = -1;
	let steady = 0;
	while (Date.now() < deadline) {
		const loading =
			host.querySelectorAll(
				".math:not(.is-loaded), .internal-embed:not(.is-loaded)",
			).length +
			[...host.querySelectorAll("img")].filter((img) => !img.complete).length;
		const size = host.innerHTML.length;
		// One quiet step can sit between two slow renderers' updates.
		steady = loading === 0 && size === last ? steady + 1 : 0;
		if (steady >= STEADY_STEPS) return true;
		last = size;
		await sleep(SETTLE_STEP_MS);
	}
	return false;
}

/** Returns how many images could not be inlined. */
async function inline(
	app: App,
	sourcePath: string,
	images: { img: HTMLImageElement; link: string }[],
): Promise<number> {
	let left = 0;
	let room = IMAGES_TOTAL_MAX_CHARS;
	// An image shown twice is read once; each copy still counts against the room.
	const read = new Map<string, Promise<string | null>>();
	for (const { img, link } of images) {
		if (!read.has(link)) {
			read.set(
				link,
				inlineImage(app, sourcePath, link).catch(() => null),
			);
		}
		const uri = await read.get(link);
		if (uri && uri.length <= room) {
			img.setAttribute("src", uri);
			room -= uri.length;
		} else {
			img.remove();
			left++;
		}
	}
	return left;
}

function dropAll(images: { img: HTMLImageElement }[]): number {
	for (const { img } of images) img.remove();
	return images.length;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
