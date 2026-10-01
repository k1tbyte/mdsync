import { type Plugin, TFolder, type Vault } from "obsidian";
import { reportWarning } from "@/shared";
import {
	mountError,
	type PendingMove,
	type SpaceRecords,
	spacesOf,
} from "@/spaces";
import { isUnder } from "@/sync/space";
import { notifyError, notifyInfo } from "@/ui";

import type { PluginHost } from "./host";

type MoveVault = Pick<
	Vault,
	"getAbstractFileByPath" | "rename" | "createFolder" | "delete"
>;

/** Roots the follower is renaming now: their rename events are its own. */
const following = new Set<string>();

/**
 * Follows moves from another device before the partition is fixed, so an old root never becomes vault
 * content. A blocked move syncs in place and retries every refresh.
 */
export function createMoveFollower(
	vault: MoveVault,
	spaces: SpaceRecords,
	notify: (message: string, err: unknown) => void,
): () => Promise<void> {
	const warned = new Set<string>();
	return async () => {
		for (const move of spaces.moves()) {
			try {
				await follow(vault, spaces, move);
				await spaces.settle(move.id);
			} catch (err) {
				if (warned.has(move.id)) continue;
				warned.add(move.id);
				notify(`Could not move "${move.from}" to "${move.to}" here`, err);
			}
		}
	};
}

/** A shared folder renamed here, or one it is in, moves on the person's other devices too. */
export function registerShareRenames(plugin: Plugin & PluginHost): void {
	const movingBack = new Set<number>();
	plugin.register(() => {
		for (const timer of movingBack) window.clearTimeout(timer);
	});
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFolder) {
				onFolderRenamed(plugin, file, oldPath, movingBack).catch((err) =>
					reportWarning("A shared folder could not be moved.", err),
				);
			}
		}),
	);
}

async function follow(
	vault: MoveVault,
	spaces: SpaceRecords,
	{ id, from, to }: PendingMove,
): Promise<void> {
	const folder = vault.getAbstractFileByPath(from);
	// Gone here: the share mounts at its new root as it would at the old one.
	if (!(folder instanceof TFolder)) return;
	const others = spacesOf(spaces.list().filter((each) => each.id !== id));
	const error = mountError(to, others);
	if (error) throw new Error(error);
	const existing = vault.getAbstractFileByPath(to);
	if (existing) {
		if (!(existing instanceof TFolder) || existing.children.length > 0) {
			throw new Error("That path is taken.");
		}
		await vault.delete(existing);
	}
	const parent = to.slice(0, Math.max(0, to.lastIndexOf("/")));
	if (parent !== "" && !vault.getAbstractFileByPath(parent)) {
		await vault.createFolder(parent);
	}
	following.add(from);
	try {
		await vault.rename(folder, to);
	} finally {
		following.delete(from);
	}
}

async function onFolderRenamed(
	plugin: Plugin & PluginHost,
	folder: TFolder,
	oldPath: string,
	movingBack: Set<number>,
): Promise<void> {
	if (following.has(oldPath)) return;
	const { spaces } = plugin;
	const open = spaces.list().filter((each) => !each.closed);
	const moved = open.filter((each) => isUnder(each.root, oldPath));
	if (moved.length === 0) return;
	const others = spacesOf(open.filter((each) => !moved.includes(each)));
	const targets = moved.map(({ id, root }) => ({
		id,
		root: folder.path + root.slice(oldPath.length),
	}));
	if (targets.some(({ root }) => mountError(root, others) !== null)) {
		notifyInfo(
			`Moved "${folder.path}" back: a shared folder cannot go into another shared folder or a hidden one.`,
		);
		// Out of the event, once the rename that fired it is done.
		const back = window.setTimeout(() => {
			movingBack.delete(back);
			plugin.app.fileManager
				.renameFile(folder, oldPath)
				.catch((err) =>
					notifyError(`Could not move "${folder.path}" back`, err),
				);
		}, 0);
		movingBack.add(back);
		return;
	}
	const author = plugin.controller.currentDevice().id;
	// A pull running now would go on writing under the old path, which is the vault's from here.
	plugin.controller.cancel();
	// Every root changes in this tick, before any refresh can start on half of them.
	const saved = Promise.all(
		targets.map(({ id, root }) => spaces.moveRoot(id, root, author)),
	);
	plugin.scheduleScopeRefresh("Shared folder moved.");
	await saved;
}
