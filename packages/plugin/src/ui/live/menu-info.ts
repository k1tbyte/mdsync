export function infoTitle(text: string, state?: string): DocumentFragment {
	const title = createFragment();
	title.createSpan({ cls: "obsync-menu-info", text });
	if (state) title.createSpan({ cls: "obsync-person-state", text: state });
	return title;
}
