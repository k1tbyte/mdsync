import { type App, FileView, type Workspace } from "obsidian";

import type { Here } from "./people";

/** Away after this long without input; a hidden window is away at once. */
const IDLE_AFTER_MS = 5 * 60_000;
const IDLE_CHECK_MS = 30_000;
/** Flicking through tabs announces only where it stops. */
const SETTLE_MS = 400;
const ACTIVITY = ["keydown", "pointerdown", "pointermove", "wheel"] as const;

/** Reports this device's open file and whether its person is at it; returns the stop. */
export function watchHere(app: App, report: (here: Here) => void): () => void {
	const { workspace } = app;
	let lastInput = Date.now();
	let sent: Here | null = null;
	let timer: number | null = null;

	const current = (): Here => ({
		path: openActivePath(workspace),
		idle:
			document.visibilityState === "hidden" ||
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

	const refs = [
		workspace.on("active-leaf-change", settle),
		workspace.on("file-open", settle),
		workspace.on("layout-change", settle),
	];
	const renamed = app.vault.on("rename", settle);
	for (const type of ACTIVITY) {
		window.addEventListener(type, onInput, { passive: true });
	}
	document.addEventListener("visibilitychange", send);
	const check = window.setInterval(send, IDLE_CHECK_MS);
	workspace.onLayoutReady(send);

	return () => {
		for (const ref of refs) workspace.offref(ref);
		app.vault.offref(renamed);
		for (const type of ACTIVITY) window.removeEventListener(type, onInput);
		document.removeEventListener("visibilitychange", send);
		window.clearInterval(check);
		if (timer !== null) window.clearTimeout(timer);
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
