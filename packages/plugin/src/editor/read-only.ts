import { EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField, type Plugin } from "obsidian";

import type { PluginHost } from "@/plugin/host";

/** Notes of a read-only share take no typing: nothing typed there could sync. */
export function registerReadOnlyLock(plugin: Plugin & PluginHost): void {
	const { vault, workspace } = plugin.app;
	const mutable: Extension[] = [];
	plugin.registerEditorExtension(mutable);
	let roots: readonly string[] = [];
	// A fresh extension, or CodeMirror keeps the value computed for the same view.
	const lock = (): void => {
		mutable.length = 0;
		if (roots.length > 0) mutable.push(lockIn(roots));
		workspace.updateOptions();
	};
	plugin.register(
		watchReadOnlyRoots(plugin, (now) => {
			roots = now;
			lock();
		}),
	);
	// A moved note keeps its view: only a rebuilt lock reads its new path.
	plugin.registerEvent(
		vault.on("rename", () => {
			if (roots.length > 0) lock();
		}),
	);
}

/** Calls `onChange` whenever the read-only share roots change; returns the stop. */
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

function lockIn(roots: readonly string[]): Extension {
	const locked = (state: EditorState): boolean => {
		const path = state.field(editorInfoField, false)?.file?.path;
		return (
			path !== undefined && roots.some((root) => path.startsWith(`${root}/`))
		);
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
