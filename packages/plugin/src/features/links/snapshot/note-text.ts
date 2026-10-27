import { type App, MarkdownView, type TFile } from "obsidian";

/** An open view is newer than the file it saves a moment later; `getViewData` is right in source and reading mode. */
export async function noteText(app: App, file: TFile): Promise<string> {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const { view } = leaf;
		if (view instanceof MarkdownView && view.file?.path === file.path) {
			return view.getViewData();
		}
	}
	return app.vault.read(file);
}
