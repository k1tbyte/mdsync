import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { appendIconButton } from "@/ui/common/icon-button";

export interface LineWrappingOptions {
	lineWrapping: boolean;
	showLineWrappingToggle: boolean;
	onLineWrappingChange(enabled: boolean): void;
}

export class LineWrappingControl {
	private readonly compartment = new Compartment();
	private button: HTMLButtonElement | null = null;
	private enabled: boolean;

	constructor(
		private readonly options: LineWrappingOptions,
		private readonly views: () => ReadonlyArray<EditorView | null | undefined>,
		private readonly onLayout: () => void,
	) {
		this.enabled = options.lineWrapping;
	}

	extension(): Extension {
		return this.compartment.of(this.enabled ? EditorView.lineWrapping : []);
	}

	mount(parent: HTMLElement): void {
		if (!this.options.showLineWrappingToggle) return;
		this.button = appendIconButton(
			parent,
			"wrap-text",
			"Toggle line wrapping",
			() => this.toggle(),
		);
		this.button.createSpan({ cls: "obsync-phone-button-label", text: "Wrap" });
		this.render();
	}

	private toggle(): void {
		this.enabled = !this.enabled;
		for (const view of this.views()) {
			view?.dispatch({
				effects: this.compartment.reconfigure(
					this.enabled ? EditorView.lineWrapping : [],
				),
			});
		}
		this.options.onLineWrappingChange(this.enabled);
		this.render();
		this.onLayout();
	}

	private render(): void {
		const button = this.button;
		if (!button) return;
		button.toggleClass("is-active", this.enabled);
		button.setAttr("aria-pressed", String(this.enabled));
		button.setAttr(
			"aria-label",
			this.enabled ? "Disable line wrapping" : "Enable line wrapping",
		);
	}
}
