import type { PauseKind } from "@/spaces";

export type Pause = Exclude<PauseKind, "off">;

const PAUSE: readonly (readonly [Pause | null, string])[] = [
	[null, "Off"],
	["here", "On this device"],
	["everywhere", "On all my devices"],
];

/** One segmented choice; native radios, so arrow keys move it. Locked while `choose` saves. */
export function renderPauseControl(
	parent: HTMLElement,
	heading: HTMLElement,
	name: string,
	current: () => Pause | null,
	choose: (pause: Pause | null) => Promise<void>,
): void {
	// Named by its heading: an `aria-label` would show as a tooltip over the whole bar.
	heading.id = `${name}-heading`;
	const group = parent.createDiv({
		cls: "mdsync-segments",
		attr: { role: "radiogroup", "aria-labelledby": heading.id },
	});
	const inputs = PAUSE.map(([pause, text]) => {
		const label = group.createEl("label", { cls: "mdsync-segment" });
		const input = label.createEl("input", { type: "radio", attr: { name } });
		label.createSpan({ text });
		input.addEventListener("change", async () => {
			for (const each of inputs) each.disabled = true;
			try {
				await choose(pause);
			} finally {
				for (const each of inputs) each.disabled = false;
				show();
				// Disabling dropped the keyboard's focus to the body; focus moved elsewhere meanwhile stays.
				if (activeDocument.activeElement === activeDocument.body) {
					inputs.find((each) => each.checked)?.focus();
				}
			}
		});
		return input;
	});
	const show = (): void => {
		const now = current();
		PAUSE.forEach(([pause], i) => {
			const input = inputs[i];
			if (input) input.checked = pause === now;
		});
	};
	show();
}
