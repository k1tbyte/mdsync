import { copyWithFeedback } from "./clipboard";
import { button as iconButton } from "./icons";

const LABEL = "Copy";

/** Obsidian's copy button on each code block: the snapshot's own left without its script. */
export function addCopyButtons(body: HTMLElement): void {
	for (const code of Array.from(body.querySelectorAll("pre > code"))) {
		const button = iconButton(
			body.ownerDocument,
			"copy-code-button",
			"copy",
			LABEL,
		);
		button.addEventListener(
			"click",
			() => void copyWithFeedback(button, LABEL, () => code.textContent ?? ""),
		);
		code.after(button);
	}
}
