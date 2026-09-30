import { EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Plugin } from "obsidian";
import {
	type ExcalidrawApi,
	type ExcalidrawView,
	isViewMode,
	LIVE_VIEWS,
	setViewMode,
} from "@/live";
import type { PluginHost } from "@/plugin/host";

const LOADING_RETRY_MS = 500;

/** Notes and drawings of a read-only share take no edits: nothing made there could sync. */
export function registerReadOnlyLock(plugin: Plugin & PluginHost): void {
	const { vault, workspace } = plugin.app;
	const mutable: Extension[] = [];
	plugin.registerEditorExtension(mutable);
	let roots: readonly string[] = [];
	const lockDrawings = registerDrawingLock(plugin, (path) =>
		under(roots, path),
	);
	// A fresh extension, or CodeMirror keeps the value computed for the same view.
	const lock = (): void => {
		mutable.length = 0;
		if (roots.length > 0) mutable.push(lockIn(roots));
		workspace.updateOptions();
		lockDrawings();
	};
	plugin.register(
		watchReadOnlyRoots(plugin, (now) => {
			roots = now;
			lock();
		}),
	);
	// A moved note keeps its view: only a rebuilt lock reads its new path.
	plugin.registerEvent(
		vault.on("rename", (file, oldPath) => {
			if (under(roots, file.path) || under(roots, oldPath)) lock();
		}),
	);
}

/** Calls `onChange` with the read-only share roots whenever they change; returns the stop. */
export function watchReadOnlyRoots(
	plugin: PluginHost,
	onChange: (roots: readonly string[]) => void,
): () => void {
	let shown = "";
	const check = (): void => {
		const roots = plugin.spaces
			.partition()
			.filter(({ readOnly }) => readOnly)
			.map(({ root }) => root);
		const key = roots.join("\n");
		if (key === shown) return;
		shown = key;
		onChange(roots);
	};
	check();
	return plugin.controller.subscribe(check);
}

function under(roots: readonly string[], path: string): boolean {
	return roots.some((root) => path.startsWith(`${root}/`));
}

function lockIn(roots: readonly string[]): Extension {
	const locked = (state: EditorState): boolean => {
		const path = state.field(editorInfoField, false)?.file?.path;
		return path !== undefined && under(roots, path);
	};
	return [
		Prec.highest([
			EditorView.editable.compute([editorInfoField], (state) => !locked(state)),
			// Obsidian sets the attribute itself, over what `editable` says.
			EditorView.contentAttributes.compute(
				[editorInfoField],
				(state): Record<string, string> =>
					locked(state) ? { contenteditable: "false" } : {},
			),
		]),
		EditorState.readOnly.compute([editorInfoField], locked),
	];
}

/** Keeps locked drawings in Excalidraw's view mode and lets out only the views it put there. */
function registerDrawingLock(
	plugin: Plugin,
	locked: (path: string) => boolean,
): () => void {
	const { workspace } = plugin.app;
	const watched = new Map<
		ExcalidrawView,
		{ api: ExcalidrawApi; off: () => void }
	>();
	const mine = new Set<ExcalidrawView>();
	let retry: number | null = null;

	const views = (): ExcalidrawView[] =>
		workspace
			.getLeavesOfType(LIVE_VIEWS.drawing)
			.map(({ view }) => view as ExcalidrawView);
	const lockedView = (view: ExcalidrawView): boolean => {
		const path = view.file?.path;
		return path !== undefined && locked(path);
	};
	/** Only these need their changes heard: `follow` leaves every other view be. */
	const held = (view: ExcalidrawView): boolean =>
		lockedView(view) || mine.has(view);
	const follow = (view: ExcalidrawView, viewMode: boolean): void => {
		const lock = lockedView(view);
		if (lock === viewMode || (!lock && !mine.has(view))) return;
		if (lock) mine.add(view);
		else mine.delete(view);
		setViewMode(view, lock);
	};

	const check = (): void => {
		const open = views();
		for (const view of mine) if (!open.includes(view)) mine.delete(view);
		for (const [view, { api, off }] of watched) {
			if (open.includes(view) && held(view) && view.excalidrawAPI === api) {
				continue;
			}
			off();
			watched.delete(view);
		}
		// Nothing announces a drawing done loading.
		let loading = false;
		for (const view of open) {
			if (!held(view)) continue;
			const api = view.excalidrawAPI;
			if (!api) {
				loading ||= lockedView(view);
				continue;
			}
			if (!watched.has(view)) {
				const off = api.onChange((_, appState) =>
					follow(view, isViewMode(appState)),
				);
				watched.set(view, { api, off });
			}
			follow(view, isViewMode(api.getAppState()));
		}
		if (!loading) return;
		retry ??= window.setTimeout(() => {
			retry = null;
			check();
		}, LOADING_RETRY_MS);
	};

	plugin.registerEvent(workspace.on("file-open", check));
	plugin.registerEvent(workspace.on("layout-change", check));
	plugin.register(() => {
		if (retry !== null) window.clearTimeout(retry);
		for (const { off } of watched.values()) off();
		for (const view of views()) if (mine.has(view)) setViewMode(view, false);
	});
	return check;
}
