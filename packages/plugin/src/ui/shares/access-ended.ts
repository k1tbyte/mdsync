import type { Plugin } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";
import type { Space } from "@/sync/space";
import { openConfirmModal } from "@/ui/modals";

import { closeHere } from "./share-action";

/** Past the broker's KV lag (~60 s) and its cached refusal (60 s). */
const RECHECK_MS = 90_000;

/** The owner ended this link: the share closes as on Leave and the person chooses what happens to its files. */
export function createAccessEnded(
	plugin: Plugin & PluginHost,
): (space: Space) => void {
	const refusedSince = new Map<string, number>();
	const rechecks = new Set<number>();
	const ending = new Set<string>();
	plugin.register(() => {
		for (const timer of rechecks) window.clearTimeout(timer);
	});
	return (space) => {
		const record = plugin.spaces.get(space.id);
		if (record?.access.kind !== "participant" || record.closed) return;
		const { token } = record.access;
		const since = refusedSince.get(token);
		if (since === undefined) {
			refusedSince.set(token, Date.now());
			const timer = window.setTimeout(() => {
				rechecks.delete(timer);
				void plugin.controller.refresh();
			}, RECHECK_MS);
			rechecks.add(timer);
			return;
		}
		if (Date.now() - since < RECHECK_MS || ending.has(record.id)) return;
		ending.add(record.id);
		void endAccess(plugin, record).finally(() => ending.delete(record.id));
	};
}

async function endAccess(
	plugin: PluginHost,
	record: SpaceRecord,
): Promise<void> {
	// Its token is dead: no leave call to the broker, which would only refuse it.
	await closeHere(plugin, record, false);
	const drop = await openConfirmModal({
		app: plugin.app,
		title: `Your access to "${record.name}" ended`,
		body: [
			"The owner removed you from this shared folder, stopped sharing it, or sent you a new link.",
			`Its files in "${record.root}" stay in your vault as a regular folder.`,
		],
		confirmLabel: "Delete the folder",
		cancelLabel: "Keep the files",
		confirmClass: "mod-warning",
	});
	const folder = plugin.app.vault.getFolderByPath(record.root);
	if (drop && folder) await plugin.app.fileManager.trashFile(folder);
}
