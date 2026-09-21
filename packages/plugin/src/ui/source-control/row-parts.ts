import { formatBytes } from "@/shared/format";

/** The compact size badge: signed delta stacked over the current size. */
export function renderSize(
	parent: HTMLElement,
	size: number,
	delta?: number,
): HTMLElement {
	const el = parent.createSpan({
		cls: ["obsync-file-size", ...(delta === undefined ? [] : ["has-delta"])],
	});
	if (delta !== undefined) {
		const { sign, cls } = deltaParts(delta);
		el.createSpan({
			cls: `obsync-file-size-delta ${cls}`,
			text: `${sign}${formatBytes(Math.abs(delta))}`,
		});
	}
	el.createSpan({ cls: "obsync-file-size-current", text: formatBytes(size) });
	return el;
}

/** File name in full, with the folder trailing it faintly when asked for. */
export function renderPath(
	parent: HTMLElement,
	path: string,
	withParent = true,
): HTMLElement {
	const separator = path.lastIndexOf("/");
	const copy = parent.createSpan({ cls: "obsync-file-copy" });
	copy.createSpan({ cls: "obsync-file-name", text: path.slice(separator + 1) });
	if (withParent && separator > 0) {
		copy.createSpan({
			cls: "obsync-file-parent",
			text: path.slice(0, separator),
		});
	}
	return copy;
}

function deltaParts(delta: number): { sign: string; cls: string } {
	if (delta > 0) return { sign: "+", cls: "is-positive" };
	if (delta < 0) return { sign: "−", cls: "is-negative" };
	return { sign: "±", cls: "is-neutral" };
}
