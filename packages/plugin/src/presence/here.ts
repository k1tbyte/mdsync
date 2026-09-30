import { type App, FileView, type Workspace } from "obsidian";

import type { Here } from "./people";

/** Away after this long without input; a hidden window is away at once. */
const IDLE_AFTER_MS = 5 * 60_000;
const IDLE_CHECK_MS = 30_000;
/** Flicking through tabs announces only where it stops. */
const SETTLE_MS = 400;
const ACTIVITY = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

export interface HereWatch {
	/** After the note setting changed: reports again if what is shown differs. */
	refresh(): void;
	stop(): void;
}

/** Reports this device's open file (unless `showNote` says to hide it) and whether its person is at it. */
export function watchHere(
	app: App,
	report: (here: Here) => void,
	showNote: () => boolean,
): HereWatch {
	const { workspace } = app;
	let lastInput = Date.now();
	let sent: Here | null = null;
	let timer: number | null = null;
	/** The main window and every popout: input in any of them is presence. */
	const windows = new Set<Window>();

	const current = (): Here => ({
		path: showNote() ? openActivePath(workspace) : null,
		idle:
			[...windows].every((win) => win.document.visibilityState === "hidden") ||
			Date.now() - lastInput > IDLE_AFTER_MS,
	});
	const send = (): void => {
		timer = null;
		const here = current();
		if (sent?.path === here.path && sent.idle === here.idle) return;
		sent = here;
		report(here);
	};
	const settle = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(send, SETTLE_MS);
	};
	const onInput = (): void => {
		lastInput = Date.now();
		if (sent?.idle) send();
	};

	const watch = (win: Window): void => {
		if (windows.has(win)) return;
		windows.add(win);
		for (const type of ACTIVITY) {
			win.addEventListener(type, onInput, { passive: true });
		}
		win.document.addEventListener("visibilitychange", send);
	};
	const unwatch = (win: Window): void => {
		if (!windows.delete(win)) return;
		for (const type of ACTIVITY) win.removeEventListener(type, onInput);
		win.document.removeEventListener("visibilitychange", send);
	};

	watch(window);
	const refs = [
		workspace.on("active-leaf-change", settle),
		workspace.on("file-open", settle),
		workspace.on("layout-change", settle),
		workspace.on("window-open", (_, win) => watch(win)),
		workspace.on("window-close", (_, win) => {
			unwatch(win);
			settle();
		}),
	];
	const renamed = app.vault.on("rename", settle);
	const check = window.setInterval(send, IDLE_CHECK_MS);
	let stopped = false;
	workspace.onLayoutReady(() => {
		if (stopped) return;
		// Popouts restored with the layout opened before this watch.
		workspace.iterateAllLeaves((leaf) => watch(leaf.getContainer().win));
		send();
	});

	return {
		refresh: send,
		stop() {
			stopped = true;
			for (const ref of refs) workspace.offref(ref);
			app.vault.offref(renamed);
			for (const win of [...windows]) unwatch(win);
			window.clearInterval(check);
			if (timer !== null) window.clearTimeout(timer);
		},
	};
}

/** The active file while a tab still shows it: Obsidian keeps naming the last one after it closed. */
function openActivePath(workspace: Workspace): string | null {
	const path = workspace.getActiveFile()?.path ?? null;
	if (path === null) return null;
	let open = false;
	workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof FileView && leaf.view.file?.path === path) {
			open = true;
		}
	});
	return open ? path : null;
}
