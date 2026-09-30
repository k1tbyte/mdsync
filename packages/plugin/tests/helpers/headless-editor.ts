import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { MarkdownView } from "obsidian";
import { vi } from "vitest";

export function headlessEditor(text: string) {
	let state = EditorState.create({ doc: text });
	let value = text;
	const cm = {
		get state() {
			return state;
		},
		dispatch: vi.fn((spec: TransactionSpec) => {
			state = state.update(spec).state;
		}),
	};
	const editor = {
		cm,
		getValue: () => value,
		setValue: vi.fn((next: string) => {
			value = next;
		}),
		undo: vi.fn(),
		redo: vi.fn(),
	};
	return { cm, editor, view: { editor } as unknown as MarkdownView };
}
