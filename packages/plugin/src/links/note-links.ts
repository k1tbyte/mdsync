import type { PluginHost } from "@/plugin/host";

import { expiryLine } from "./describe";
import { isExpired, isStale, type LinkRecord } from "./record";

/** A note's live links, and whether one still shows a copy older than the note. */
export interface NoteLinks {
	records: LinkRecord[];
	stale: boolean;
}

/** Null when the note has no links, or only expired ones. */
export function noteLinks(plugin: PluginHost, path: string): NoteLinks | null {
	const records = plugin.sharedLinks
		.of(path)
		.filter((record) => !isExpired(record));
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
