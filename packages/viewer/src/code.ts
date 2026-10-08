import { copyWithFeedback } from "./clipboard";
import { el } from "./dom";

const LABEL = "Copy";

/** Obsidian's copy button on each code block: the snapshot's own left without its script. */
export function addCopyButtons(body: HTMLElement): void {
	for (const code of Array.from(body.querySelectorAll("pre > code"))) {
		const button = el(
			body.ownerDocument,
			"button",
			{ type: "button", class: "copy-code-button" },
			LABEL,
		);
		button.addEventListener(
			"click",
			() => void copyWithFeedback(button, LABEL, () => code.textContent ?? ""),
		);
		code.after(button);
	}
}
