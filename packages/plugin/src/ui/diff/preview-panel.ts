import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

export class PreviewPanel {
	private view: EditorView | null = null;

	render(parent: HTMLElement, text: string, label: string): void {
		this.destroy();
		const header = parent.createDiv({ cls: "mdsync-diff-preview-header" });
		header.createSpan({ text: label });

		const container = parent.createDiv({ cls: "mdsync-diff-preview-body" });
		this.view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: text,
				extensions: [
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					lineNumbers(),
					EditorView.lineWrapping,
				],
			}),
		});
	}

	destroy(): void {
		this.view?.destroy();
		this.view = null;
	}
}
