import { type App, Component, MarkdownRenderer, type TFile } from "obsidian";

import { inlineImage } from "./images";
import { mathToMathML, tagMathSources } from "./math";
import { sanitizeRendered } from "./sanitize";

/** Roughly what a note's own text leaves of the link's size limit. */
const IMAGES_TOTAL_MAX_CHARS = 4 * 1024 * 1024;
const SETTLE_MAX_MS = 5000;
const SETTLE_STEP_MS = 100;

export interface Snapshot {
	html: string;
	/** Milliseconds, just before the note was read. */
	takenAt: number;
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
	const host = activeDocument.body.createDiv({ cls: "mdsync-link-render" });
	const component = new Component();
	component.load();
	const untag = await tagMathSources(markdown);
	try {
		await MarkdownRenderer.render(app, markdown, host, file.path, component);
		await settled(host);
		mathToMathML(host);
		const report = sanitizeRendered(host);
		const images = options.images
			? await inline(app, file.path, report.images)
			: dropAll(report.images);
		return {
			html: host.innerHTML,
			left: {
				embeds: report.embedsDropped,
				images,
				diagrams: report.mermaidAsSource,
			},
		};
	} finally {
		untag();
		component.unload();
		host.remove();
	}
}

/** Renders asynchronously: math, embeds and images arrive after `render` resolves. */
async function settled(host: HTMLElement): Promise<void> {
	const deadline = Date.now() + SETTLE_MAX_MS;
	let last = -1;
	while (Date.now() < deadline) {
		const loading =
			host.querySelectorAll(
				".math:not(.is-loaded), .internal-embed:not(.is-loaded)",
			).length +
			[...host.querySelectorAll("img")].filter((img) => !img.complete).length;
		const size = host.innerHTML.length;
		if (loading === 0 && size === last) return;
		last = size;
		await sleep(SETTLE_STEP_MS);
	}
}

/** Returns how many images could not be inlined. */
async function inline(
	app: App,
	sourcePath: string,
	images: { img: HTMLImageElement; link: string }[],
): Promise<number> {
	let left = 0;
	let room = IMAGES_TOTAL_MAX_CHARS;
	for (const { img, link } of images) {
		const uri = await inlineImage(app, sourcePath, link).catch(() => null);
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
