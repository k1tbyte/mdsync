import type { Vault } from "obsidian";

export interface IndexedFile {
	path: string;
	size: number;
	mtime: number;
}

export interface IndexedFolder {
	path: string;
	isEmpty: boolean;
}

/**
 * Obsidian's in-memory path, size and mtime for every non-hidden file; reading it avoids thousands of adapter
 * IPC round trips. Hidden folders (`configDir`) still need the adapter.
 */
export interface VaultIndex {
	files(): ReadonlyArray<IndexedFile>;
	folders(): ReadonlyArray<IndexedFolder>;
	readonly configDir: string;
	/** Through the vault, so open tabs follow; false for a file it cannot see or a taken `to`. */
	rename(from: string, to: string): Promise<boolean>;
}

export function createVaultIndex(vault: Vault): VaultIndex {
	return {
		configDir: vault.configDir,
		rename: (from, to) => renameInVault(vault, from, to),
		files() {
			return vault.getFiles().map((file) => ({
				path: file.path,
				size: file.stat.size,
				mtime: file.stat.mtime,
			}));
		},
		folders() {
			const out: IndexedFolder[] = [];
			for (const folder of vault.getAllFolders(false)) {
				// A root that slipped through carries "/" and is not a syncable path.
				if (!folder.path || folder.path === "/") continue;
				out.push({ path: folder.path, isEmpty: folder.children.length === 0 });
			}
			return out;
		},
	};
}

/** Only the file: the device that renamed it rewrote the links, and those edits sync. */
export async function renameInVault(
	vault: Vault,
	from: string,
	to: string,
): Promise<boolean> {
	const file = vault.getFileByPath(from);
	const taken = vault.getAbstractFileByPath(to);
	// A case-blind lookup finds the file itself at its new case.
	if (!file || (taken && taken !== file)) return false;
	const parent = to.slice(0, Math.max(0, to.lastIndexOf("/")));
	if (parent !== "" && !vault.getAbstractFileByPath(parent)) {
		await vault.createFolder(parent);
	}
	await vault.rename(file, to);
	return true;
}
