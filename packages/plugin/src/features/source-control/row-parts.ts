import { formatBytes } from "@/core/shared";
import { RESOLUTION_TEXT, type Resolution } from "@/features/sync";

/** A group's heading, with the resolution its versions are kept at where that changes. */
export function renderAgeHeader(
	parent: HTMLElement,
	{ label, chip }: { label: string; chip: Resolution | null },
): void {
	const header = parent.createDiv({ cls: "mdsync-timeline-day" });
	header.createSpan({ text: label });
	if (chip)
		header.createSpan({
			cls: "mdsync-timeline-res",
			text: RESOLUTION_TEXT[chip],
		});
}

/** The compact size badge: signed delta stacked over the current size. */
export function renderSize(
	parent: HTMLElement,
	size: number,
	delta?: number,
): HTMLElement {
	const el = parent.createSpan({
		cls: ["mdsync-file-size", ...(delta === undefined ? [] : ["has-delta"])],
	});
	if (delta !== undefined) renderDelta(el, delta, "mdsync-file-size-delta");
	el.createSpan({ cls: "mdsync-file-size-current", text: formatBytes(size) });
	return el;
}

/** A signed size change: green grew, red shrank. */
export function renderDelta(
	parent: HTMLElement,
	delta: number,
	cls: string,
): HTMLElement {
	const { sign, tone } = deltaParts(delta);
	return parent.createSpan({
		cls: ["mdsync-size-delta", tone, cls],
		text: `${sign}${formatBytes(Math.abs(delta))}`,
	});
}

function deltaParts(delta: number): { sign: string; tone: string } {
	if (delta > 0) return { sign: "+", tone: "is-positive" };
	if (delta < 0) return { sign: "−", tone: "is-negative" };
	return { sign: "±", tone: "is-neutral" };
}
