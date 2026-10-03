import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ButtonComponent, Platform } from "obsidian";

import { appendIconButton, appendLabeledButton, notifyInfo } from "@/ui/common";

import {
	hunkTitle,
	presentChunk,
	presentSyncChange,
	type SyncChange,
} from "./helpers";
import { revertHunk } from "./hunk-revert";
import type { SignsProvider } from "./provider";

const MAX_LINES = 30;

export interface HunkTarget {
	view: EditorView;
	chunk: Chunk;
	baseline: Text;
	provider: SignsProvider;
	path: string | null;
	syncChange: SyncChange | null;
}

export function buildPopup(
	target: HunkTarget,
	dismiss: () => void,
): HTMLElement {
	const { view, chunk, baseline, provider, path, syncChange } = target;
	const { removedLines, addedLines } = syncChange
		? presentSyncChange(syncChange)
		: presentChunk(chunk, baseline, view.state.doc);
	const title = hunkTitle(removedLines.length, addedLines.length);
	const popup = createDiv({ cls: "mdsync-hunk-popup" });
	popup.setAttribute("role", "dialog");
	popup.setAttribute("aria-label", title);

	const header = popup.createDiv({ cls: "mdsync-hunk-popup-header" });
	header.createSpan({ cls: "mdsync-hunk-popup-title", text: title });
	const controls = header.createDiv({ cls: "mdsync-hunk-popup-controls" });
	const wrapButton = appendLabeledButton(controls, "wrap-text", "Wrap", () =>
		setWrapped(!wrapped),
	);
	appendIconButton(controls, "x", "Close", dismiss);

	const body = popup.createDiv({ cls: "mdsync-hunk-popup-body" });
	let wrapped = Platform.isPhone;
	const setWrapped = (next: boolean): void => {
		wrapped = next;
		body.toggleClass("is-wrapped", wrapped);
		wrapButton.setAttr("aria-pressed", String(wrapped));
	};
	setWrapped(wrapped);
	renderLines(body, removedLines, "removed", "-");
	renderLines(body, addedLines, "added", "+");

	const footer = popup.createDiv({ cls: "mdsync-hunk-popup-footer" });
	const { doc } = view.state;
	const whileUnchanged = (action: () => void) => () => {
		if (view.state.doc !== doc) {
			notifyInfo("The note changed. Open the change again.");
		} else {
			action();
		}
		dismiss();
	};
	if (path !== null && syncChange !== null) {
		new ButtonComponent(footer)
			.setButtonText("Push hunk")
			.setCta()
			.onClick(
				whileUnchanged(() => {
					void provider.pushHunk(path, syncChange, doc.toString());
				}),
			);
	}
	new ButtonComponent(footer)
		.setButtonText("Revert hunk")
		.setDestructive()
		.onClick(
			whileUnchanged(() => revertHunk(view, baseline, chunk, syncChange)),
		);
	return popup;
}

function renderLines(
	parent: HTMLElement,
	lines: readonly string[],
	kind: "removed" | "added",
	prefix: string,
): void {
	for (const line of lines.slice(0, MAX_LINES)) {
		const row = parent.createDiv({
			cls: `mdsync-hunk-popup-line-${kind}`,
		});
		row.createSpan({ cls: "mdsync-hunk-popup-prefix", text: prefix });
		row.createSpan({ cls: "mdsync-hunk-popup-text", text: line });
	}
	if (lines.length > MAX_LINES) {
		parent.createDiv({
			cls: "mdsync-hunk-popup-truncated",
			text: `… ${lines.length - MAX_LINES} more line(s)`,
		});
	}
}
