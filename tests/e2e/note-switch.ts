/**
 * Switching notes in one leaf: change signs never show one note's baseline against another's text, and
 * the header's live mark holds between two live notes.
 */

import { read } from "./device";
import { open, type } from "./editor";
import { check } from "./harness";
import type { Obsidian } from "./obsidian";
import { accept, invite, mounted, runSharing, shareFolder } from "./sharing";

const TEXTS = [
	["Team/a.md", "alpha"],
	["Team/b.md", "beta"],
] as const;
const NOTES = TEXTS.map(([path]) => path);
const SWITCHES = 8;
const DWELL_MS = 1_500;
const LIVE = "mdsync-live-dot is-live";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
declare const window: Window & { mdsyncSamples?: Sample[] };

interface Sample {
	/** The note the editor's text belongs to. */
	doc: string;
	signs: number;
	mark: string;
}

const lines = (tag: string) =>
	Array.from({ length: 12 }, (_, at) => `${tag} line ${at + 1}\n`).join("");

await runSharing(
	"note switch e2e",
	{
		owner: Object.fromEntries(TEXTS.map(([path, tag]) => [path, lines(tag)])),
		friend: {},
	},
	async (owner, friend, s3) => {
		await shareFolder(owner, s3, "Team");
		await accept(friend, await invite(owner, "Team", "Friend"));
		await mounted(friend, "Shared/Team/a.md");
		for (const path of NOTES) {
			await open(owner, path);
			await type(owner, "end", "edited\n");
		}
		const steady = await settled(owner);

		// A slow disk: Obsidian points the view at the next note well before its text arrives.
		await owner.evaluate(() => {
			const read = app.vault.read.bind(app.vault);
			app.vault.read = async (file: unknown) => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return read(file);
			};
			// The window of a hidden desktop never has focus; the editor's focus changes need it.
			document.hasFocus = () => true;
		});
		await sample(owner, true);
		for (let at = 0; at < SWITCHES; at++) {
			await owner.evaluate(
				async (path) => {
					const leaf = app.workspace.getLeaf(false);
					const { cm } = leaf.view.editor;
					cm.contentDOM.blur();
					const opening = leaf.openFile(app.vault.getFileByPath(path));
					// The editor takes focus back while the note loads, as after the quick switcher.
					setTimeout(() => cm.focus(), 20);
					await opening;
				},
				NOTES[at % 2],
			);
			await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
		}
		const samples = await sample(owner, false);

		check(
			"no frame shows more signs than its note has",
			samples.filter(({ doc, signs }) => signs > (steady[doc] ?? 0)),
			[],
		);
		check(
			"the live mark holds through every switch",
			[...new Set(samples.map(({ mark }) => mark))],
			[LIVE],
		);
		for (const [path, tag] of TEXTS) {
			check(
				`${path} keeps its own text`,
				await read(owner, path),
				`${lines(tag)}edited\n`,
			);
		}
	},
);

/** Each note's sign count once it is live and diffed. */
async function settled(owner: Obsidian): Promise<Record<string, number>> {
	const steady: Record<string, number> = {};
	for (const path of NOTES) {
		await open(owner, path);
		const [doc, signs] = await owner.waitFor(
			`${path} live with signs`,
			() => {
				const { containerEl, editor } =
					app.workspace.getLeavesOfType("markdown")[0].view;
				const mark = containerEl.querySelector(
					".mdsync-note-presence:not(.mdsync-hidden) .mdsync-live-dot",
				);
				return [
					editor.getLine(0),
					containerEl.querySelectorAll(".mdsync-sign").length,
					mark?.className,
				];
			},
			([, signs, mark]) => signs > 0 && mark === LIVE,
		);
		steady[doc] = signs;
	}
	check("each note has signs of its own", Object.keys(steady).length, 2);
	return steady;
}

/** Samples the editor every few milliseconds, between tasks: what a frame could paint. */
function sample(owner: Obsidian, start: boolean): Promise<Sample[]> {
	return owner.evaluate((start) => {
		if (!start) {
			const samples = window.mdsyncSamples ?? [];
			delete window.mdsyncSamples;
			return samples;
		}
		const samples: Sample[] = [];
		window.mdsyncSamples = samples;
		const tick = () => {
			if (window.mdsyncSamples !== samples) return;
			const { containerEl, editor } =
				app.workspace.getLeavesOfType("markdown")[0].view;
			const header = containerEl.querySelector(".mdsync-note-presence");
			samples.push({
				doc: editor.getLine(0),
				signs: containerEl.querySelectorAll(".mdsync-sign").length,
				mark: header?.classList.contains("mdsync-hidden")
					? "hidden"
					: (header?.querySelector(".mdsync-live-dot")?.className ?? "none"),
			});
			setTimeout(tick, 2);
		};
		tick();
		return samples;
	}, start);
}
