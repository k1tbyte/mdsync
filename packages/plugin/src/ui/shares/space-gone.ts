import type { PluginHost } from "@/plugin/host";
import type { Space } from "@/sync/space";
import { runWithNotice } from "@/ui/common";
import { openChoiceModal } from "@/ui/modals";

const RESTORE = {
	key: "restore",
	label: "Restore here",
	cls: "mod-cta",
} as const;
const DELETE = {
	key: "delete",
	label: "Delete for everyone",
	cls: "mod-warning",
} as const;

/** Asks once per share and launch; the Changes tab asks again on demand. */
export function createSpaceGone(plugin: PluginHost): (space: Space) => void {
	const asked = new Set<string>();
	return (space) => {
		if (asked.has(space.id)) return;
		asked.add(space.id);
		void askSpaceGone(plugin, space);
	};
}

/** A share lost every file it had here: they come back, or their loss reaches everyone in it. */
export async function askSpaceGone(
	plugin: PluginHost,
	space: Space,
): Promise<void> {
	const choice = await openChoiceModal<"restore" | "delete">({
		app: plugin.app,
		title: `"${space.root}" lost its files on this device`,
		body: [
			"None of the files it had are here any more, so nothing of it syncs. Bring them back from the shared folder, or delete them for everyone in it. Close this to decide later.",
		],
		choices: space.readOnly ? [RESTORE] : [DELETE, RESTORE],
	});
	if (choice === null) return;
	await runWithNotice(
		() => plugin.controller.settleGone(space, choice),
		choice === "restore"
			? `Restored "${space.root}".`
			: `Deleted the files of "${space.root}" for everyone.`,
		`Could not settle "${space.root}"`,
	);
}
