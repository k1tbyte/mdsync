import type { DataAdapter } from "obsidian";

import { caseInsensitiveDisk } from "./io";

type Listing = { files: ReadonlySet<string>; folders: ReadonlySet<string> };

/**
 * The paths a folder listing shows are gone. Obsidian's `stat` reads ENOENT as absent, and a storage bridge
 * (ChromeOS shared folders) can answer ENOENT for a folder that is there: one stat must not publish a deletion.
 */
export async function confirmGone(
	adapter: DataAdapter,
	paths: readonly string[],
): Promise<Set<string>> {
	// Another casing on such a disk may be the same entry: unknown, not gone.
	const fold = caseInsensitiveDisk()
		? (path: string) => path.toLowerCase()
		: (path: string) => path;
	const listings = new Map<string, Promise<Listing | null>>();
	const list = (dir: string): Promise<Listing | null> => {
		let listing = listings.get(dir);
		if (!listing) {
			listing = adapter.list(dir).then(
				({ files, folders }) => ({
					files: new Set(files.map(fold)),
					folders: new Set(folders.map(fold)),
				}),
				() => null,
			);
			listings.set(dir, listing);
		}
		return listing;
	};
	const gone = new Set<string>();
	for (const path of paths) {
		if (await isGone(path, list, fold)) gone.add(path);
	}
	return gone;
}

/** The nearest folder that lists decides; one still naming it, or none readable up to the root, is unknown. */
async function isGone(
	path: string,
	list: (dir: string) => Promise<Listing | null>,
	fold: (path: string) => string,
): Promise<boolean> {
	let child = path;
	let kind: keyof Listing = "files";
	while (child !== "") {
		const dir = child.slice(0, Math.max(0, child.lastIndexOf("/")));
		const listing = await list(dir);
		if (listing) return !listing[kind].has(fold(child));
		child = dir;
		kind = "folders";
	}
	return false;
}
