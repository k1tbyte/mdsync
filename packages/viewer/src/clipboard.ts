/** How long a copy button shows how the copy went. */
const RESULT_MS = 1500;

/** False when the browser refuses: no permission, or a page not served over https. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** Copies what `text` makes and says on `button` how it went, then puts `label` back. */
export async function copyWithFeedback(
	button: HTMLElement,
	label: string,
	text: () => string,
): Promise<void> {
	let copied = false;
	try {
		copied = await copyText(text());
	} catch {
		// A note that cannot be converted just fails to copy.
	}
	button.textContent = copied ? "Copied" : "Copy failed";
	window.setTimeout(() => {
		button.textContent = label;
	}, RESULT_MS);
}
