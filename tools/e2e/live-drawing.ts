/**
 * Live drawing between two real Obsidians with the Excalidraw plugin: shapes
 * drawn on either side reach the other, concurrent edits keep both, a deletion
 * spreads, pointers show, the file sync of the saved drawings settles
 * although each device saves its own view state into the file, and a drawing
 * open but not live takes what the file sync writes.
 */

import { excalidrawPlugin } from "./excalidraw";
import { check, runScenario, sleep } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { type Relay, startRelay } from "./relay";
import { startWebDav } from "./webdav";

const RELAY_PORT = 8799;
const DAV_PORT = 8801;
const CDP_PORTS = [9223, 9224];
const SECRET = "e2e-secret";
const PASSPHRASE = "e2e-passphrase";
const DRAWING = "sketch.excalidraw.md";
const OTHER = "other.excalidraw.md";
const CONVERGE_TRIES = 50;
const CONVERGE_MS = 200;

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
// biome-ignore lint/suspicious/noExplicitAny: so is the Excalidraw library.
declare const window: any;

const RECTANGLE = {
	id: "r1",
	type: "rectangle",
	x: 0,
	y: 0,
	width: 100,
	height: 50,
	angle: 0,
	strokeColor: "#1e1e1e",
	backgroundColor: "transparent",
	fillStyle: "solid",
	strokeWidth: 2,
	strokeStyle: "solid",
	roughness: 1,
	opacity: 100,
	groupIds: [],
	frameId: null,
	roundness: null,
	seed: 1,
	version: 1,
	versionNonce: 1,
	isDeleted: false,
	boundElements: null,
	updated: 1,
	link: null,
	locked: false,
	index: "a0",
};
/** A drawing file holding one rectangle. */
function drawingFile(id: string): string {
	const scene = {
		type: "excalidraw",
		version: 2,
		elements: [{ ...RECTANGLE, id }],
		appState: { viewBackgroundColor: "#ffffff" },
		files: {},
	};
	return `---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n# Excalidraw Data\n\n## Text Elements\n%%\n## Drawing\n\`\`\`json\n${JSON.stringify(scene)}\n\`\`\`\n%%\n`;
}

await runScenario("live drawing e2e", async () => {
	const relay: Relay = await startRelay(RELAY_PORT, SECRET);
	const dav = await startWebDav(DAV_PORT);
	const plugin = await excalidrawPlugin();
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
				files: { [DRAWING]: drawingFile("r1") },
				plugins: [plugin],
			});
			devices.push(device);
			// One at a time: the first to unlock writes the vault's keyfile.
			await unlock(device);
			await openDrawing(device);
		}
		const [laptop, desktop] = devices as [Obsidian, Obsidian];
		await coEdit(laptop, desktop);
		await switchDrawings(laptop, desktop);
		await pointers(laptop, desktop);
		await fileSync(laptop, desktop);
		await coldWrite(laptop, desktop);
	} finally {
		relay.stop();
		dav.stop();
		await Promise.all(devices.map((device) => device.stop()));
	}
});

async function coEdit(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await draw(laptop, "L1", 300);
	check(
		"the desktop sees the laptop draw",
		await shapesOn(desktop, (shapes) => shapes.includes("L1")),
		["L1", "r1"],
	);

	await Promise.all([move(laptop, "r1", 40), draw(desktop, "D1", -300)]);
	const together = await converged(laptop, desktop);
	check(
		"concurrent edits keep both",
		[together.join(), await xOf(desktop, "r1")],
		["D1,L1,r1", 40],
	);

	await erase(desktop, "L1");
	check(
		"a deletion reaches the other",
		await shapesOn(laptop, (shapes) => !shapes.includes("L1")),
		["D1", "r1"],
	);
}

/** A leaf switched to another drawing names it a moment before it shows it. */
async function switchDrawings(
	laptop: Obsidian,
	desktop: Obsidian,
): Promise<void> {
	await laptop.evaluate(
		async ({ path, text }) => void (await app.vault.create(path, text)),
		{
			path: OTHER,
			text: drawingFile("o1"),
		},
	);
	// Excalidraw picks its view by front matter, so a new file opens as markdown until indexed.
	await laptop.waitFor(
		"drawing indexed",
		() =>
			app.metadataCache.getFileCache(
				app.vault.getFileByPath("other.excalidraw.md"),
			)?.frontmatter?.["excalidraw-plugin"],
		Boolean,
	);
	await openDrawing(laptop, OTHER);
	const other = await shapesOn(laptop, (shapes) => !shapes.includes("r1"));
	await openDrawing(laptop, DRAWING);
	check(
		"switching drawings in one leaf carries nothing across",
		[other, await converged(laptop, desktop)],
		[["o1"], ["D1", "r1"]],
	);
}

async function pointers(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await laptop.evaluate(() => {
		const view = app.workspace.getLeavesOfType("excalidraw")[0].view;
		const box = view.contentEl.getBoundingClientRect();
		view.contentEl.dispatchEvent(
			new PointerEvent("pointermove", {
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2,
				bubbles: true,
			}),
		);
	});
	check(
		"the desktop shows the laptop's pointer",
		await desktop.waitFor(
			"remote pointer",
			() =>
				app.workspace
					.getLeavesOfType("excalidraw")[0]
					.view.excalidrawAPI.getAppState().collaborators.size,
			(size) => size === 1,
		),
		1,
	);
	await desktop.shot("live-drawing");
}

/** Each device saves its own zoom and scroll; the sync must still see one drawing. */
async function fileSync(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await laptop.evaluate(() =>
		app.workspace
			.getLeavesOfType("excalidraw")[0]
			.view.excalidrawAPI.updateScene({
				appState: { scrollX: 400, zoom: { value: 2 } },
				captureUpdate: "NEVER",
			}),
	);
	await Promise.all([save(laptop), save(desktop)]);
	const runs: Synced[] = [];
	for (const device of [laptop, desktop, laptop, desktop]) {
		runs.push(await sync(device));
	}
	check(
		"the saved drawings sync without conflicts",
		runs.map(({ error, conflicts }) => [error, conflicts]),
		runs.map(() => [null, 0]),
	);
	await Promise.all([save(laptop), save(desktop)]);
	const settled = await Promise.all([laptop, desktop].map(sync));
	check(
		"once in step, saving again is nothing to sync",
		settled.map(({ pendingLocal, pendingRemote }) => [
			pendingLocal,
			pendingRemote,
		]),
		[
			[0, 0],
			[0, 0],
		],
	);
	check(
		"the room still holds everything after the sync",
		await converged(laptop, desktop),
		["D1", "r1"],
	);
}

/** Excalidraw takes a save's own write for the next one: what the file sync writes must still show. */
async function coldWrite(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await laptop.evaluate(async () => {
		const obsync = app.plugins.plugins.obsync;
		obsync.settings.liveEditing = false;
		await obsync.realtime.live.refresh();
		// Plain JSON, so the file can be searched for a shape.
		app.plugins.plugins["obsidian-excalidraw-plugin"].settings.compress = false;
	});
	await save(laptop);
	await draw(desktop, "C1", 600);
	await save(desktop);
	await sync(desktop);
	await sync(laptop);
	check(
		"a drawing open but not live shows what the file sync wrote under it",
		await shapesOn(laptop, (shapes) => shapes.includes("C1")),
		["C1", "D1", "r1"],
	);
	await save(laptop);
	check(
		"and its next save keeps it",
		await laptop.evaluate(
			async (path) => (await app.vault.adapter.read(path)).includes('"C1"'),
			DRAWING,
		),
		true,
	);
}

function draw(device: Obsidian, id: string, x: number): Promise<void> {
	return device.evaluate(
		({ id, x, template }) => {
			const api =
				app.workspace.getLeavesOfType("excalidraw")[0].view.excalidrawAPI;
			const elements = api.getSceneElementsIncludingDeleted();
			const last = elements[elements.length - 1];
			const shape = {
				...template,
				id,
				x,
				versionNonce: Math.floor(Math.random() * 2 ** 31),
				// Above everything drawn so far.
				index: `${last.index}V`,
			};
			api.updateScene({
				elements: [...elements, shape],
				captureUpdate: window.ExcalidrawLib.CaptureUpdateAction.IMMEDIATELY,
			});
		},
		{ id, x, template: RECTANGLE },
	);
}

function move(device: Obsidian, id: string, x: number): Promise<void> {
	return edit(device, id, { x });
}

function erase(device: Obsidian, id: string): Promise<void> {
	return edit(device, id, { isDeleted: true });
}

function edit(
	device: Obsidian,
	id: string,
	change: Record<string, unknown>,
): Promise<void> {
	return device.evaluate(
		({ id, change }) => {
			const lib = window.ExcalidrawLib;
			const api =
				app.workspace.getLeavesOfType("excalidraw")[0].view.excalidrawAPI;
			const elements = api
				.getSceneElementsIncludingDeleted()
				// biome-ignore lint/suspicious/noExplicitAny: an Excalidraw element.
				.map((element: any) =>
					element.id === id ? lib.newElementWith(element, change) : element,
				);
			api.updateScene({
				elements,
				captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY,
			});
		},
		{ id, change },
	);
}

function shapesOn(
	device: Obsidian,
	accept: (shapes: string[]) => boolean,
): Promise<string[]> {
	return device.waitFor(
		"shapes",
		() =>
			app.workspace
				.getLeavesOfType("excalidraw")[0]
				.view.excalidrawAPI.getSceneElements()
				.map(({ id }: { id: string }) => id)
				.sort(),
		accept,
	);
}

/** Both views show the same shapes at the same versions, twice running. */
async function converged(a: Obsidian, b: Obsidian): Promise<string[]> {
	let last = "";
	for (let attempt = 0; attempt < CONVERGE_TRIES; attempt++) {
		const [mine, theirs] = await Promise.all([
			a.evaluate(stamps),
			b.evaluate(stamps),
		]);
		if (mine === theirs && mine === last) {
			return mine.split(",").map((stamp) => stamp.split("@")[0] ?? "");
		}
		last = mine;
		await sleep(CONVERGE_MS);
	}
	throw new Error(`drawings never converged: ${last}`);
}

function stamps(): string {
	return app.workspace
		.getLeavesOfType("excalidraw")[0]
		.view.excalidrawAPI.getSceneElements()
		.map(
			({ id, version }: { id: string; version: number }) => `${id}@${version}`,
		)
		.sort()
		.join();
}

function xOf(device: Obsidian, id: string): Promise<number> {
	return device.evaluate(
		(id) =>
			app.workspace
				.getLeavesOfType("excalidraw")[0]
				.view.excalidrawAPI.getSceneElements()
				.find((element: { id: string }) => element.id === id)?.x,
		id,
	);
}

function save(device: Obsidian): Promise<void> {
	return device.evaluate(() =>
		app.workspace.getLeavesOfType("excalidraw")[0].view.save(true, true),
	);
}

interface Synced {
	error: string | null;
	conflicts: number;
	pendingLocal: number;
	pendingRemote: number;
}

function sync(device: Obsidian): Promise<Synced> {
	return device.evaluate(async () => {
		const { controller } = app.plugins.plugins.obsync;
		await controller.refreshAndAutoSync();
		await controller.refresh();
		const { error, conflicts, pendingLocal, pendingRemote } =
			controller.getSnapshot();
		return { error, conflicts, pendingLocal, pendingRemote };
	});
}

async function openDrawing(
	device: Obsidian,
	path: string = DRAWING,
): Promise<void> {
	await device.waitFor(
		"excalidraw loaded",
		() => Boolean(app.plugins.plugins["obsidian-excalidraw-plugin"]),
		Boolean,
	);
	await device.evaluate(async (path) => {
		await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(path));
	}, path);
	try {
		await device.waitFor(
			"drawing bound",
			() =>
				[...app.plugins.plugins.obsync.realtime.live.bound.values()].map(
					(binding: { path: string }) => binding.path,
				),
			(paths) => paths.length === 1 && paths[0] === path,
		);
	} catch (err) {
		// A bind that never came once in ~10 runs: say where it stopped.
		console.log(await device.evaluate(bindState, path));
		throw err;
	}
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

async function bindState(path: string): Promise<string> {
	const live = app.plugins.plugins.obsync.realtime.live;
	const view = app.workspace.getLeavesOfType("excalidraw")[0]?.view;
	return JSON.stringify({
		file: view?.file?.path,
		shown: view?.excalidrawData?.file?.path,
		api: Boolean(view?.excalidrawAPI),
		rooms: [...live.rooms.keys()],
		synced: live.rooms.get(path)?.session.synced,
		joining: live.joining(path),
		space: Boolean(await live.deps.liveSpace(path)),
		hub: app.plugins.plugins.obsync.realtime.hub.isConnected(),
	});
}
