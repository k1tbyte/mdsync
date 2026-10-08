import { copyWithFeedback } from "./clipboard";

const LABEL = "Copy";

/** Obsidian's copy button on each code block: the snapshot's own left without its script. */
export function addCopyButtons(body: HTMLElement): void {
	for (const code of Array.from(body.querySelectorAll("pre > code"))) {
		const button = body.ownerDocument.createElement("button");
		button.type = "button";
		button.className = "copy-code-button";
		button.textContent = LABEL;
		button.addEventListener("click", () =>
			copyWithFeedback(button, LABEL, () => code.textContent ?? ""),
		);
		code.after(button);
	}
}
