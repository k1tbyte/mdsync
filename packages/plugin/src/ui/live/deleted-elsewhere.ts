import type { PluginHost } from "@/plugin/host";
import { spaceOf } from "@/sync/space";
import { notifyError, runWithNotice } from "@/ui/common";
import { openChoiceModal } from "@/ui/modals";

/** Another device deleted a note open here: the person decides whether it goes here too or comes back everywhere. */
export function createDeletedElsewhere(
	plugin: PluginHost,
): (path: string) => void {
	const asking = new Set<string>();
	return (path) => {
		if (asking.has(path)) return;
		asking.add(path);
		void ask(plugin, path).finally(() => asking.delete(path));
	};
}

async function ask(plugin: PluginHost, path: string): Promise<void> {
	const { app, controller, spaces } = plugin;
	const { readOnly } = spaceOf(spaces.partition(), path);
	const name = app.vault.getFileByPath(path)?.basename ?? path;
	const choice = await openChoiceModal({
		app,
		title: `"${name}" was deleted on another device`,
		body: [
			"It was open here, so your copy stays, as a new file only here. Close this to decide later.",
		],
		choices: [
			{ key: "delete", label: "Delete here", cls: "mod-warning" },
			{
				key: "keep",
				label: readOnly ? "Keep here" : "Keep and push",
				cls: "mod-cta",
			},
		],
	});
	const file = app.vault.getFileByPath(path);
	if (choice === null || !file) return;
	if (choice === "keep") {
		if (readOnly) return;
		await runWithNotice(
			() => controller.pushPaths([path]),
			`Pushed "${name}".`,
			`Could not push "${name}"`,
		);
		return;
	}
	try {
		await app.fileManager.trashFile(file);
	} catch (err) {
		notifyError(`Could not delete "${name}"`, err);
	}
}
