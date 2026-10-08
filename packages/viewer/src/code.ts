import { copyText } from "./clipboard";

/** How long a copy button shows how the copy went. */
const RESULT_MS = 1500;
const LABEL = "Copy";

/** Obsidian's copy button on each code block: the snapshot's own left without its script. */
export function addCopyButtons(body: HTMLElement): void {
	for (const code of Array.from(body.querySelectorAll("pre > code"))) {
		const button = body.ownerDocument.createElement("button");
		button.type = "button";
		button.className = "copy-code-button";
		button.textContent = LABEL;
		button.addEventListener("click", async () => {
			const copied = await copyText(code.textContent ?? "");
			button.textContent = copied ? "Copied" : "Copy failed";
			setTimeout(() => {
				button.textContent = LABEL;
			}, RESULT_MS);
		});
		code.after(button);
	}
}
