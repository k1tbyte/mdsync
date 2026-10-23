/** File name in full, with the folder trailing it faintly when asked for. */
export function renderPath(
	parent: HTMLElement,
	path: string,
	withParent = true,
): HTMLElement {
	const separator = path.lastIndexOf("/");
	const copy = parent.createSpan({ cls: "mdsync-file-copy" });
	copy.createSpan({ cls: "mdsync-file-name", text: path.slice(separator + 1) });
	if (withParent && separator > 0) {
		copy.createSpan({
			cls: "mdsync-file-parent",
			text: path.slice(0, separator),
		});
	}
	return copy;
}
