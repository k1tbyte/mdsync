/** An observer never reports another window's element, so it comes from the element's own and is rebuilt when Obsidian moves the tab to a popout. */
export function observeResize(
	el: HTMLElement,
	onResize: () => void,
): () => void {
	let observer: ResizeObserver | null = null;
	const bind = (): void => {
		observer?.disconnect();
		observer = new (el.win as typeof window).ResizeObserver(onResize);
		observer.observe(el);
	};
	bind();
	const unmigrated = el.onWindowMigrated(bind);
	return () => {
		unmigrated();
		observer?.disconnect();
	};
}
