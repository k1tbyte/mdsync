import { setIcon } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";

import { describePeople, renderAvatarStack } from "@/ui/live/avatars";
import { lastEditLabel } from "@/ui/live/last-edit";
import { openShareWindow, shareAt } from "@/ui/shares/share-window";
import { setIndicatorTooltip } from "./indicator-tooltip";

export type ShareKind = "owned" | "joined" | "read-only" | "paused";

export interface ShareMark {
	root: string;
	kind: ShareKind;
	/** People in its notes and at them. */
	here: number;
}

export interface PresenceMarks {
	share?: ShareMark;
	people?: Person[];
	/** The "new" dot's tooltip: who changed it, or how many changed below. */
	unseen?: string;
}

const SHARE_ICONS: Record<ShareKind, string> = {
	owned: "share-2",
	joined: "users",
	"read-only": "eye",
	paused: "pause",
};
const SHARE_ROOT_ATTR = "data-share-root";
const SHARE_TOOLTIPS: Record<ShareKind, string> = {
	owned: "Shared folder: you invite who can open it",
	joined: "Shared with you",
	"read-only": "Shared with you, read-only",
	paused: "Shared folder, paused on this device",
};

/** The share badges alone: the only way into a share's window from the tree. */
export function shareMarks(
	plugin: PluginHost,
	spaces: readonly Space[] = plugin.spaces.partition(),
): Map<string, PresenceMarks> {
	const out = new Map<string, PresenceMarks>();
	for (const space of spaces) {
		if (space.id === VAULT_SPACE.id) continue;
		const inNotes = plugin.realtime.people
			.online(space.id)
			.filter(({ note, idle }) => note !== null && !idle);
		out.set(space.root, {
			share: {
				root: space.root,
				kind: shareKind(plugin, space),
				here: inNotes.length,
			},
		});
	}
	return out;
}

/**
 * Share roots, who is in which note and what others changed unseen. A note
 * inside a collapsed folder hands its marks to the outermost collapsed folder
 * above it, the row that shows.
 */
export function presenceMarks(
	plugin: PluginHost,
	collapsed: (folder: string) => boolean,
): Map<string, PresenceMarks> {
	const spaces = plugin.spaces.partition();
	const out = shareMarks(plugin, spaces);
	for (const [note, here] of plugin.realtime.people.notes()) {
		// The vault's own devices are not people in the tree.
		if (spaceOf(spaces, note).id === VAULT_SPACE.id) continue;
		const row = visibleRow(note, collapsed);
		const marks = out.get(row) ?? {};
		marks.people = mergePeople(marks.people ?? [], here);
		out.set(row, marks);
	}
	for (const [row, count] of unseenRows(plugin, collapsed)) {
		const marks = out.get(row) ?? {};
		marks.unseen = plugin.unseen.all().has(row)
			? (lastEditLabel(plugin, row) ?? "Changed by someone else")
			: `${count} changed by others since you opened them`;
		out.set(row, marks);
	}
	return out;
}

export function renderPresenceMarks(
	target: HTMLElement,
	marks: PresenceMarks,
): void {
	if (marks.unseen) {
		const dot = target.createSpan({
			cls: "obsync-path-badge obsync-unseen-dot",
		});
		setIndicatorTooltip(dot, marks.unseen);
	}
	if (marks.people && marks.people.length > 0) {
		const badge = target.createSpan({
			cls: "obsync-path-badge obsync-people-badge",
		});
		renderAvatarStack(badge, marks.people);
		setIndicatorTooltip(badge, `Here: ${describePeople(marks.people)}`);
	}
	if (marks.share) renderShareBadge(target, marks.share);
}

/** A share badge opens the share's window rather than folding the folder. */
export function openShareFromBadge(
	plugin: PluginHost,
	event: MouseEvent | KeyboardEvent,
): void {
	if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
	if (!(event.target instanceof Element)) return;
	const badge = event.target.closest(".obsync-share-badge");
	if (!badge) return;
	event.preventDefault();
	event.stopPropagation();
	const record = shareAt(plugin, badge.getAttribute(SHARE_ROOT_ATTR) ?? "");
	if (record) openShareWindow(plugin, record);
}

function renderShareBadge(target: HTMLElement, share: ShareMark): void {
	const badge = target.createSpan({
		cls: `obsync-path-badge obsync-share-badge is-${share.kind}`,
		attr: { [SHARE_ROOT_ATTR]: share.root, role: "button", tabindex: "0" },
	});
	setIcon(badge.createSpan(), SHARE_ICONS[share.kind]);
	const lines = [SHARE_TOOLTIPS[share.kind], "Click to manage"];
	if (share.here > 0) {
		badge.addClass("has-people");
		badge.createSpan({ cls: "obsync-share-count", text: String(share.here) });
		lines.push(`${share.here} in its notes now`);
	}
	setIndicatorTooltip(badge, lines.join("\n"));
}

function shareKind(plugin: PluginHost, space: Space): ShareKind {
	if (space.paused) return "paused";
	if (space.readOnly) return "read-only";
	const record = plugin.settings.spaces.find(({ id }) => id === space.id);
	return record?.access.kind === "participant" ? "joined" : "owned";
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

function mergePeople(into: Person[], add: readonly Person[]): Person[] {
	const byKey = new Map(into.map((person) => [person.key, person]));
	for (const person of add) {
		const known = byKey.get(person.key);
		byKey.set(person.key, {
			...person,
			idle: person.idle && (known?.idle ?? true),
		});
	}
	return [...byKey.values()];
}
