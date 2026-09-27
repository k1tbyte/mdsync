/** The first markdown editor of a device: opening a note into it, typing, reading it back. */

import { poll, sleep } from "./harness";
import type { Obsidian } from "./obsidian";

const KEYSTROKE_MS = 25;

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

/** Opens a note in the active leaf and waits until the leaf is bound to its room. */
export async function open(device: Obsidian, path: string): Promise<void> {
	await device.evaluate(async (target) => {
		await app.workspace
			.getLeaf(false)
			.openFile(app.vault.getFileByPath(target));
	}, path);
	await device.waitFor(
		`${path} bound`,
		() => {
			const live = app.plugins.plugins.obsync.realtime.live;
			return [...live.bound.values()].map((binding) => binding.path);
		},
		(paths) => paths.length === 1 && paths[0] === path,
	);
}

/** Types one character at a time, as a person would, through the editor. */
export async function type(
	device: Obsidian,
	where: "start" | "end",
	text: string,
): Promise<void> {
	await device.evaluate(
		async ({ where, text, delay }) => {
			const editor = app.workspace.getLeavesOfType("markdown")[0].view.editor;
			let at = where === "start" ? 0 : editor.getValue().length;
			for (const char of text) {
				editor.replaceRange(char, editor.offsetToPos(at));
				at += char.length;
				if (where === "end") at = editor.getValue().length;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		},
		{ where, text, delay: KEYSTROKE_MS },
	);
}

export function editorText(device: Obsidian): Promise<string> {
	return device.evaluate(() =>
		app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue(),
	);
}

export function textOn(
	device: Obsidian,
	accept: (text: string) => boolean,
): Promise<string> {
	return device.waitFor(
		"editor text",
		() => app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue(),
		accept,
	);
}

/** Both editors equal, and still equal a moment later. */
export function converged(a: Obsidian, b: Obsidian): Promise<string> {
	const texts = () => Promise.all([editorText(a), editorText(b)]);
	return poll("editors converge", async () => {
		const [left, right] = await texts();
		if (left !== right) return undefined;
		await sleep(500);
		const [again, other] = await texts();
		return again === left && other === left ? left : undefined;
	});
}
