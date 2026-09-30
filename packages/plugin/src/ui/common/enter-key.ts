import { reportError } from "./notices";
import { serial } from "./serial";

function isPlainEnter(event: KeyboardEvent): boolean {
	return (
		event.key === "Enter" &&
		!event.isComposing &&
		event.keyCode !== 229 &&
		!event.repeat &&
		!event.ctrlKey &&
		!event.altKey &&
		!event.metaKey
	);
}

export function onEnter(
	input: HTMLElement,
	action: () => void | Promise<void>,
): void {
	const run = serial(action);
	input.addEventListener("keydown", (event: KeyboardEvent) => {
		if (!isPlainEnter(event)) return;
		event.preventDefault();
		run().catch(reportError);
	});
}
