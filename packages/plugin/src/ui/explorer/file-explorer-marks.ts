import { noteLinks, noteLinksText } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { isAtNote, mergePeople, type Person } from "@/presence";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";

export type ShareKind = "owned" | "joined" | "read-only" | "paused";

export interface ShareMark {
	root: string;
	kind: ShareKind;
	/** People in its notes and at them. */
	here: number;
}

export interface UnseenMark {
	count: number;
	/** Set when the row is itself the unseen file. */
	file?: string;
}

export interface PublishedMark {
	path: string;
	count: number;
	stale: boolean;
	text: string;
}

export interface PresenceMarks {
	share?: ShareMark;
	published?: PublishedMark;
	people?: Person[];
	unseen?: UnseenMark;
}

export function shareMarks(
	plugin: PluginHost,
	spaces: readonly Space[] = plugin.spaces.partition(),
): Map<string, PresenceMarks> {
	const out = new Map<string, PresenceMarks>();
	for (const space of spaces) {
		if (space.id === VAULT_SPACE.id) continue;
		const inNotes = plugin.realtime.people.online(space.id).filter(isAtNote);
		out.set(space.root, {
			share: {
				root: space.root,
				kind: shareKind(plugin, space),
				here: inNotes.length,
			},
		});
	}
	const paths = new Set(plugin.sharedLinks.all().map(({ path }) => path));
	for (const path of paths) {
		const links = noteLinks(plugin, path);
		if (!links) continue;
		out.set(path, {
			...out.get(path),
			published: {
				path,
				count: links.records.length,
				stale: links.stale,
				text: noteLinksText(links),
			},
		});
	}
	return out;
}

/** A note inside a collapsed folder hands its marks to the outermost collapsed folder above it, the row that shows. */
export function presenceMarks(
	plugin: PluginHost,
	collapsed: (folder: string) => boolean,
): Map<string, PresenceMarks> {
	const spaces = plugin.spaces.partition();
	const out = shareMarks(plugin, spaces);
	for (const [note, here] of plugin.realtime.people.notes()) {
		if (spaceOf(spaces, note).id === VAULT_SPACE.id) continue;
		const row = visibleRow(note, collapsed);
		const marks = out.get(row) ?? {};
		marks.people = mergePeople(marks.people ?? [], here);
		out.set(row, marks);
	}
	for (const [row, count] of unseenRows(plugin, collapsed)) {
		const marks = out.get(row) ?? {};
		marks.unseen = plugin.unseen.all().has(row)
			? { count, file: row }
			: { count };
		out.set(row, marks);
	}
	return out;
}

function shareKind(plugin: PluginHost, space: Space): ShareKind {
	if (space.paused) return "paused";
	if (space.readOnly) return "read-only";
	return plugin.spaces.get(space.id)?.access.kind === "participant"
		? "joined"
		: "owned";
}

/** Files, not rows: a stale path of a file deleted while closed shows nowhere. */
function unseenRows(
	plugin: PluginHost,
	collapsed: (folder: string) => boolean,
): Map<string, number> {
	const rows = new Map<string, number>();
	for (const path of plugin.unseen.all()) {
		if (!plugin.app.vault.getFileByPath(path)) continue;
		const row = visibleRow(path, collapsed);
		rows.set(row, (rows.get(row) ?? 0) + 1);
	}
	return rows;
}

function visibleRow(
	path: string,
	collapsed: (folder: string) => boolean,
): string {
	const parts = path.split("/");
	for (let depth = 1; depth < parts.length; depth++) {
		const folder = parts.slice(0, depth).join("/");
		if (collapsed(folder)) return folder;
	}
	return path;
}
