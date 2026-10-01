/**
 * Live editing between two real Obsidians: typing from both sides across a relay restart, a room rebuild,
 * an outside write and a rename.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { converged, editorText, open, textOn, type } from "./editor";
import { check, poll, runScenario, sleep } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { type Relay, startRelay } from "./relay";
import { startWebDav } from "./webdav";

const RELAY_PORT = 8799;
const DAV_PORT = 8801;
const CDP_PORTS = [9223, 9224];
const SECRET = "e2e-secret";
const PASSPHRASE = "e2e-passphrase";
const NOTE = "note.md";
const OTHER = "other.md";
const RENAMED = "renamed.md";
/** A rebuild is refused while the other side's keystrokes keep landing. */
const REBUILD_ATTEMPTS = 10;

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runScenario("live e2e", async () => {
	let relay: Relay | null = await startRelay(RELAY_PORT, SECRET);
	const dav = await startWebDav(DAV_PORT);
	const devices: Obsidian[] = [];
	try {
		const settings = {
			storageConfigs: {
				webdav: {
					kind: "webdav",
					baseUrl: dav.url,
					basePath: "/vault",
					username: "e2e",
					password: "e2e",
					concurrency: 4,
				},
			},
			activeStorageKind: "webdav",
			realtimeSync: true,
			liveEditing: true,
			relayUrl: relay.url,
			relaySecret: SECRET,
		};
		for (const port of CDP_PORTS) {
			const device = await launchObsidian({
				port,
				settings,
				files: { [NOTE]: "hello\n", [OTHER]: "another note\n" },
			});
			devices.push(device);
			// One at a time: the first to unlock writes the vault's keyfile.
			await unlock(device);
			await open(device, NOTE);
		}
		const [laptop, desktop] = devices as [Obsidian, Obsidian];
		await scenario(laptop, desktop, async (whileDown) => {
			relay?.stop();
			relay = null;
			await whileDown();
			relay = await startRelay(RELAY_PORT, SECRET);
		});
	} finally {
		relay?.stop();
		dav.stop();
		await Promise.all(devices.map((device) => device.stop()));
	}
});

async function scenario(
	laptop: Obsidian,
	desktop: Obsidian,
	restartRelay: (whileDown: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
	await type(laptop, "end", "typed on the laptop\n");
	check(
		"the desktop sees the laptop type",
		await textOn(desktop, (text) => text.includes("typed on the laptop")),
		"hello\ntyped on the laptop\n",
	);

	await Promise.all([
		type(laptop, "start", "AAAA "),
		type(desktop, "end", "BBBB\n"),
	]);
	const together = await converged(laptop, desktop);
	check(
		"concurrent typing keeps both sides",
		[together.startsWith("AAAA hello"), together.endsWith("BBBB\n")],
		[true, true],
	);
	check(
		"each disk follows its editor",
		[await diskOf(laptop, together), await diskOf(desktop, together)],
		[together, together],
	);
	await undoesOwnTypingOnly(laptop, desktop, together);

	check(
		"each device shows the other's cursor",
		await desktop.waitFor(
			"remote cursor",
			() =>
				app.plugins.plugins.obsync.realtime.live
					.roomOf("note.md")
					?.awareness.getStates().size,
			(size) => size === 2,
		),
		2,
	);

	await restartRelay(() =>
		Promise.all([
			type(laptop, "start", "offline-L "),
			type(desktop, "end", "offline-D\n"),
		]),
	);
	const healed = await converged(laptop, desktop);
	check(
		"typing through a relay restart converges",
		[healed.startsWith("offline-L "), healed.endsWith("offline-D\n")],
		[true, true],
	);

	await open(laptop, OTHER);
	await sleep(1_000);
	check(
		"another file in the same leaf stays out of the room",
		(await editorText(desktop)).includes("another note"),
		false,
	);
	await open(laptop, NOTE);
	check("reopening rejoins the room", await converged(laptop, desktop), healed);

	await coldSync(laptop, desktop);
	await rebuild(laptop, desktop);
	await externalWrite(laptop, desktop);
	await renameLive(laptop, desktop);
}

/**
 * The phone toolbar (`editor.undo()`) and the Edit menu (`beforeinput`) take back this device's typing,
 * never what came after it from another.
 */
async function undoesOwnTypingOnly(
	laptop: Obsidian,
	desktop: Obsidian,
	before: string,
): Promise<void> {
	await type(laptop, "end", "mine ");
	await textOn(desktop, (text) => text.endsWith("mine "));
	await type(desktop, "end", "theirs");
	await textOn(laptop, (text) => text.endsWith("theirs"));
	const undone = `${before}theirs`;

	await laptop.evaluate(() =>
		app.workspace.getLeavesOfType("markdown")[0].view.editor.undo(),
	);
	await textOn(desktop, (text) => !text.includes("mine"));
	check(
		"the toolbar's undo takes back only this device's typing",
		await converged(laptop, desktop),
		undone,
	);

	await laptop.evaluate(() =>
		app.workspace.getLeavesOfType("markdown")[0].view.editor.redo(),
	);
	await textOn(desktop, (text) => text.includes("mine "));
	await laptop.evaluate(() =>
		app.workspace
			.getLeavesOfType("markdown")[0]
			.view.editor.cm.contentDOM.dispatchEvent(
				new InputEvent("beforeinput", {
					inputType: "historyUndo",
					bubbles: true,
					cancelable: true,
				}),
			),
	);
	await textOn(desktop, (text) => !text.includes("mine"));
	check(
		"the Edit menu's undo does too",
		await converged(laptop, desktop),
		undone,
	);
}

/** A write under an open note (git, another sync) joins the room, beside what the editor has not saved. */
async function externalWrite(
	laptop: Obsidian,
	desktop: Obsidian,
): Promise<void> {
	const before = await saved(laptop, desktop);
	await type(desktop, "end", " typed");
	await textOn(laptop, (text) => text.endsWith(" typed"));
	writeFileSync(join(laptop.vault, NOTE), `${before} written`);
	await textOn(desktop, (text) => text.includes(" written"));
	const after = await converged(laptop, desktop);
	check(
		"a write under an open note keeps the typing it did not see",
		[
			after.startsWith(before),
			after.includes(" typed"),
			after.includes(" written"),
		],
		[true, true, true],
	);
}

/** One device rebuilds the room while the other types; both carry on in its successor. */
async function rebuild(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	const before = await saved(laptop, desktop);
	const typing = type(desktop, "end", "\nduring the rebuild");
	let outcome = "";
	for (let left = REBUILD_ATTEMPTS; left > 0 && outcome !== "moved"; left--) {
		outcome = await laptop.evaluate(() =>
			app.plugins.plugins.obsync.realtime.live.rotate("note.md"),
		);
		if (outcome !== "moved") await sleep(300);
	}
	await typing;
	check("the rebuild goes through", outcome, "moved");
	check(
		"both devices move into the successor",
		await Promise.all(
			[laptop, desktop].map((device) =>
				device.waitFor(
					"successor bound",
					() =>
						app.plugins.plugins.obsync.realtime.live.roomOf("note.md")
							?.generation,
					(generation) => generation === 1,
				),
			),
		),
		[1, 1],
	);
	check(
		"typing through a rebuild lands once",
		await converged(laptop, desktop),
		`${before}\nduring the rebuild`,
	);
	await type(desktop, "end", "\nafter");
	await textOn(laptop, (text) => text.endsWith("\nafter"));

	await saved(laptop, desktop);
	const pushed = await sync(laptop);
	const pulled = await sync(desktop);
	check(
		"a snapshot of the successor is no conflict",
		[pushed.conflicts, pushed.mark?.gen, pulled.conflicts, pulled.pendingLocal],
		[0, 1, 0, 0],
	);
}

/** The file sync next to live typing: snapshots of one room never conflict. */
async function coldSync(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await type(laptop, "end", "same line");
	const first = await saved(laptop, desktop);
	const pushed = await sync(laptop);
	check(
		"a quiet live note is pushed as a room snapshot",
		[pushed.error, pushed.conflicts, pushed.pendingLocal, pushed.mark !== null],
		[null, 0, 0, true],
	);

	await type(desktop, "end", " and more");
	const second = await saved(laptop, desktop);
	const other = await sync(desktop);
	check(
		"another device's snapshot of the room is no conflict",
		[
			other.error,
			other.conflicts,
			other.pendingLocal,
			(other.mark?.seq ?? 0) > (pushed.mark?.seq ?? 0),
		],
		[null, 0, 0, true],
	);
	const back = await sync(laptop);
	check(
		"both devices end in step",
		[back.conflicts, back.pendingLocal, await editorText(laptop)],
		[0, 0, second],
	);
	check("the text is not duplicated", first.length < second.length, true);

	await open(laptop, OTHER);
	await type(desktop, "end", "\nwhile closed");
	const third = await textOn(desktop, (text) => text.endsWith("while closed"));
	await diskOf(desktop, third);
	await sync(desktop);
	const pulled = await sync(laptop);
	check(
		"a closed note takes the room's snapshot",
		[pulled.conflicts, await diskOf(laptop, third)],
		[0, third],
	);
	await open(laptop, NOTE);
	check(
		"reopening after a file pull adds nothing twice",
		await converged(laptop, desktop),
		third,
	);
}

/** Renamed while open, the note takes its room along: the other device renames its file and types on in it. */
async function renameLive(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	const before = await saved(laptop, desktop);
	await laptop.evaluate(
		(to) => app.fileManager.renameFile(app.vault.getFileByPath("note.md"), to),
		RENAMED,
	);
	const rooms = await Promise.all(
		[laptop, desktop].map((device) =>
			device.waitFor(
				"room renamed",
				() =>
					app.plugins.plugins.obsync.realtime.live.roomOf("renamed.md")?.docId,
				Boolean,
			),
		),
	);
	check("both devices end in the moved room", rooms[0], rooms[1]);
	await type(desktop, "end", "\nafter the rename");
	const after = await converged(laptop, desktop);
	check("typing goes on in one room", after, `${before}\nafter the rename`);
	await Promise.all([laptop, desktop].map((d) => diskOf(d, after, RENAMED)));

	await sync(laptop);
	await sync(desktop);
	const back = await sync(laptop);
	check(
		"the file sync ends with one note on both",
		[back.conflicts, back.pendingLocal, ...(await notes(laptop, desktop))],
		[0, 0, "other.md,renamed.md", "other.md,renamed.md"],
	);
}

function notes(...devices: Obsidian[]): Promise<string[]> {
	return Promise.all(
		devices.map((device) =>
			device.evaluate(() =>
				app.vault
					.getMarkdownFiles()
					.map((file: { path: string }) => file.path)
					.sort()
					.join(","),
			),
		),
	);
}

/** Both editors agree and both files hold it. */
async function saved(a: Obsidian, b: Obsidian): Promise<string> {
	const text = await converged(a, b);
	await Promise.all([diskOf(a, text), diskOf(b, text)]);
	return text;
}

interface Synced {
	error: string | null;
	conflicts: number;
	pendingLocal: number;
	mark: { doc: string; gen: number; seq: number } | null;
}

function sync(device: Obsidian): Promise<Synced> {
	return device.evaluate(async () => {
		const { controller } = app.plugins.plugins.obsync;
		await controller.refreshAndAutoSync();
		const snapshot = controller.getSnapshot();
		return {
			error: snapshot.error,
			conflicts: snapshot.conflicts,
			pendingLocal: snapshot.pendingLocal,
			mark: snapshot.result?.remote?.files["note.md"]?.live ?? null,
		};
	});
}

async function unlock(device: Obsidian): Promise<void> {
	await device.waitFor(
		"hub connected",
		() => app.plugins.plugins.obsync.realtime?.hub.isConnected(),
		Boolean,
	);
	await device.evaluate(
		(passphrase) =>
			app.plugins.plugins.obsync.passphrase.replacePassphrase(passphrase),
		PASSPHRASE,
	);
}

function diskOf(
	device: Obsidian,
	expected: string,
	path = NOTE,
): Promise<string> {
	return poll(`${path} saved`, async () => {
		const text = readFileSync(join(device.vault, path), "utf8");
		return text === expected ? text : undefined;
	});
}
