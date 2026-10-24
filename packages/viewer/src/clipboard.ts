/** How long a copy button shows how the copy went. */
const RESULT_MS = 1500;
/** Each button's pending reset: a second copy restarts it, so the latest result stays its full time. */
const resets = new WeakMap<HTMLElement, number>();

/** False when the browser refuses: no permission, or a page not served over https. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** Copies what `text` makes and says on `button`'s label how it went, then puts `label` back. */
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
	const shown = button.querySelector(".label") ?? button;
	shown.textContent = copied ? "Copied" : "Copy failed";
	// An icon-only button shows its label while it reports.
	button.dataset.state = copied ? "copied" : "failed";
	window.clearTimeout(resets.get(button));
	resets.set(
		button,
		window.setTimeout(() => {
			shown.textContent = label;
			delete button.dataset.state;
		}, RESULT_MS),
	);
}
