import { type DataAdapter, FileSystemAdapter, Platform } from "obsidian";

/**
 * Links look like folders to Obsidian but belong to one machine: skipped like device-local ignores, never
 * pushed or read as deletions. Mobile has no Node, so it is a no-op.
 */
export interface SymlinkDetector {
	isLink(path: string): boolean;
	/** Returns the linked path itself, or its linked ancestor. */
	findLink(path: string): string | null;
	invalidate(path: string): void;
}

/** Names of the links directly inside one absolute folder, or null when it cannot be listed. */
export type LinkLister = (absoluteDir: string) => ReadonlySet<string> | null;

interface DirEntry {
	name: string;
	isSymbolicLink(): boolean;
}

interface NodeFs {
	readdirSync(
		path: string,
		options: { withFileTypes: true },
	): ReadonlyArray<DirEntry>;
}

let nodeFs: NodeFs | null = null;

const NEVER: SymlinkDetector = {
	isLink: () => false,
	findLink: () => null,
	invalidate: () => {},
};

/** @param root Vault-relative folder detector paths are relative to, for sub-tree sessions. */
export function createSymlinkDetector(
	adapter: DataAdapter,
	enabled: boolean,
	root = "",
): SymlinkDetector {
	if (!enabled || !(adapter instanceof FileSystemAdapter)) return NEVER;
	const fs = nodeFs;
	if (!fs) return NEVER;
	const ignoreCase = Platform.isWin || Platform.isMacOS;
	return symlinkDetector(
		joinPath(adapter.getBasePath(), root),
		(dir) => {
			try {
				const links = new Set<string>();
				// Windows junctions report as symbolic links here, same as lstat.
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.isSymbolicLink()) links.add(entry.name);
				}
				return links;
			} catch {
				return null;
			}
		},
		ignoreCase,
	);
}

/**
 * @param ignoreCase For case-insensitive filesystems (Windows, macOS default), where a differently spelled
 * path reaches the same file.
 */
export function symlinkDetector(
	base: string,
	listLinks: LinkLister,
	ignoreCase = false,
): SymlinkDetector {
	/**
	 * One listing answers for every child of a folder; per-path lstat costs 20k round trips per scan to learn
	 * what ~700 listings say.
	 */
	const cache = new Map<string, ReadonlySet<string> | null>();
	const fold = (name: string): string =>
		ignoreCase ? name.toLowerCase() : name;
	const linksIn = (dir: string): ReadonlySet<string> | null => {
		let links = cache.get(dir);
		if (links === undefined) {
			const listed = listLinks(joinPath(base, dir));
			links = listed && ignoreCase ? new Set([...listed].map(fold)) : listed;
			cache.set(dir, links);
		}
		return links;
	};
	const findLink = (path: string): string | null => {
		let prefix = "";
		for (const segment of path.split("/")) {
			if (!segment) continue;
			const parent = prefix;
			prefix = prefix ? `${prefix}/${segment}` : segment;
			// A linked ancestor settles it: nothing below it is ever listed.
			if (linksIn(parent)?.has(fold(segment))) return prefix;
		}
		return null;
	};
	return {
		isLink(path) {
			return findLink(path) !== null;
		},
		findLink,
		invalidate(path) {
			const changed = fold(path);
			const parent = changed.slice(0, Math.max(0, changed.lastIndexOf("/")));
			for (const dir of cache.keys()) {
				const folded = fold(dir);
				if (
					folded === parent ||
					folded === changed ||
					folded.startsWith(`${changed}/`)
				) {
					cache.delete(dir);
				}
			}
		},
	};
}

function joinPath(base: string, relative: string): string {
	if (!relative) return base;
	return `${base.replace(/[\\/]+$/, "")}/${relative}`;
}

/** Once before any detector: detection is synchronous, and mobile has no Node. */
export async function loadNodeFs(): Promise<void> {
	if (!Platform.isDesktop) return;
	nodeFs = await import("node:fs").catch(() => null);
}
