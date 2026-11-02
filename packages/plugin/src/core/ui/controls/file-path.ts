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
		// Folders read outer to inner left to right, each in its own script's direction.
		const parentEl = copy
			.createSpan({ cls: "mdsync-file-parent mdsync-path-tail" })
			.createEl("bdi", { attr: { dir: "ltr" } });
		path
			.slice(0, separator)
			.split("/")
			.forEach((folder, i) => {
				if (i > 0) parentEl.appendText("/");
				parentEl.createEl("bdi", { text: folder });
			});
	}
	return copy;
}
