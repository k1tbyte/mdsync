export function alertLine(parent: HTMLElement): HTMLElement {
	return parent.createEl("p", { cls: "mod-warning", attr: { role: "alert" } });
}
