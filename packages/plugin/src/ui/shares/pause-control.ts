import type { PauseKind } from "@/spaces";
import { renderSegments } from "@/ui/common";

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
	renderSegments(
		parent,
		name,
		PAUSE.map(([value, text]) => ({ value, text })),
		current,
		choose,
		heading.id,
	);
}
