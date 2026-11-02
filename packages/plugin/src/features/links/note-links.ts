import { expiryLine } from "./describe";
import type { LinksHost } from "./host";
import { isExpired, isStale, type LinkRecord } from "./record";

/** A note's live links, and whether one still shows a copy older than the note. */
export interface NoteLinks {
	records: LinkRecord[];
	stale: boolean;
}

/** Null when the note has no links, or only expired ones. */
export function noteLinks(
	plugin: LinksHost,
	path: string,
	/** The note's links when the caller already grouped them. */
	of: readonly LinkRecord[] = plugin.sharedLinks.of(path),
): NoteLinks | null {
	const records = of.filter((record) => !isExpired(record));
	if (records.length === 0) return null;
	const mtime = plugin.app.vault.getFileByPath(path)?.stat.mtime ?? 0;
	return { records, stale: records.some((record) => isStale(record, mtime)) };
}

/** The tooltip of a shared note's badge and header button. */
export function noteLinksText({ records, stale }: NoteLinks): string {
	const [only] = records;
	const shared =
		records.length === 1 && only
			? `Shared by link. ${expiryLine(only.expires)}`
			: `Shared by ${records.length} links.`;
	return stale
		? `${shared} Changed since it was shared: click to update.`
		: `${shared} Click to manage.`;
}
