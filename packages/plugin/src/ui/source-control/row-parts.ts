import { formatBytes } from "@/shared";

/** The compact size badge: signed delta stacked over the current size. */
export function renderSize(
	parent: HTMLElement,
	size: number,
	delta?: number,
): HTMLElement {
	const el = parent.createSpan({
		cls: ["mdsync-file-size", ...(delta === undefined ? [] : ["has-delta"])],
	});
	if (delta !== undefined) {
		const { sign, cls } = deltaParts(delta);
		el.createSpan({
			cls: `mdsync-file-size-delta ${cls}`,
			text: `${sign}${formatBytes(Math.abs(delta))}`,
		});
	}
	el.createSpan({ cls: "mdsync-file-size-current", text: formatBytes(size) });
	return el;
}

function deltaParts(delta: number): { sign: string; cls: string } {
	if (delta > 0) return { sign: "+", cls: "is-positive" };
	if (delta < 0) return { sign: "−", cls: "is-negative" };
	return { sign: "±", cls: "is-neutral" };
}
