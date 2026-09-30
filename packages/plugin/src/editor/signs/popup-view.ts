import type { Chunk } from "@codemirror/merge";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ButtonComponent, Platform } from "obsidian";

import type { SyncHunk } from "@/sync/hunks";
import { appendIconButton, appendLabeledButton } from "@/ui/common/icon-button";
import { notifyInfo } from "@/ui/common/notices";

import { hunkTitle, presentChunk, presentSyncHunk } from "./helpers";
import { revertHunk } from "./hunk-revert";
import type { SignsProvider } from "./provider";

const MAX_LINES = 30;

export interface HunkTarget {
	view: EditorView;
	chunk: Chunk;
	baseline: Text;
	provider: SignsProvider;
	path: string | null;
	syncHunk: SyncHunk | null;
}

export function buildPopup(
	target: HunkTarget,
	dismiss: () => void,
): HTMLElement {
	const { view, chunk, baseline, provider, path, syncHunk } = target;
	const { removedLines, addedLines } = syncHunk
		? presentSyncHunk(syncHunk)
		: presentChunk(chunk, baseline, view.state.doc);
	const title = hunkTitle(removedLines.length, addedLines.length);
	const popup = document.createElement("div");
	popup.className = "obsync-hunk-popup";
	popup.setAttribute("role", "dialog");
	popup.setAttribute("aria-label", title);

	const header = popup.createDiv({ cls: "obsync-hunk-popup-header" });
	header.createSpan({ cls: "obsync-hunk-popup-title", text: title });
	const controls = header.createDiv({ cls: "obsync-hunk-popup-controls" });
	const wrapButton = appendLabeledButton(controls, "wrap-text", "Wrap", () =>
		setWrapped(!wrapped),
	);
	appendIconButton(controls, "x", "Close", dismiss);

	const body = popup.createDiv({ cls: "obsync-hunk-popup-body" });
	let wrapped = Platform.isPhone;
	const setWrapped = (next: boolean): void => {
		wrapped = next;
		body.toggleClass("is-wrapped", wrapped);
		wrapButton.setAttr("aria-pressed", String(wrapped));
	};
	setWrapped(wrapped);
	renderLines(body, removedLines, "removed", "-");
	renderLines(body, addedLines, "added", "+");

	const footer = popup.createDiv({ cls: "obsync-hunk-popup-footer" });
	const { doc } = view.state;
	const whileUnchanged = (action: () => void) => () => {
		if (view.state.doc !== doc) {
			notifyInfo("The note changed. Open the change again.");
		} else {
			action();
		}
		dismiss();
	};
	if (path !== null && syncHunk !== null) {
		new ButtonComponent(footer)
			.setButtonText("Push hunk")
			.setCta()
			.onClick(
				whileUnchanged(() => {
					void provider.pushHunk(path, syncHunk, doc.toString());
				}),
			);
	}
	new ButtonComponent(footer)
		.setButtonText("Revert hunk")
		.setWarning()
		.onClick(whileUnchanged(() => revertHunk(view, baseline, chunk, syncHunk)));
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
			cls: `obsync-hunk-popup-line-${kind}`,
		});
		row.createSpan({ cls: "obsync-hunk-popup-prefix", text: prefix });
		row.createSpan({ cls: "obsync-hunk-popup-text", text: line });
	}
	if (lines.length > MAX_LINES) {
		parent.createDiv({
			cls: "obsync-hunk-popup-truncated",
			text: `… ${lines.length - MAX_LINES} more line(s)`,
		});
	}
}
