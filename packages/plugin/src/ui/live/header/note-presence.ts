import { type Plugin, setIcon, type WorkspaceLeaf } from "obsidian";

import { watchReadOnlyRoots } from "@/editor/read-only";
import type { PluginHost } from "@/plugin/host";
import {
	describePeople,
	makeActivatable,
	renderAvatarStack,
} from "@/ui/common";
import { STATE_ICONS } from "@/ui/live/live-state";
import { CursorFollow } from "./cursor-follow";
import { type HeaderState, headerOf, showsHeader } from "./header-state";
import { openActiveNoteMenu, openNoteMenu } from "./note-menu";
import { LOCKED } from "./note-menu-items";

/** A room answers in well under this: a note just opened keeps the last mark meanwhile, not a blink through joining. */
const SETTLE_MS = 1_000;

interface Shown {
	el: HTMLElement;
	/** What it shows: an unchanged header is not redrawn. */
	key: string;
	path: string;
	since: number;
}

/** Returns the active note's menu opener, as a command's check callback. */
export function registerNotePresence(
	plugin: Plugin & PluginHost,
): (checking: boolean) => boolean {
	const { workspace } = plugin.app;
	const { people, live } = plugin.realtime;
	const shown = new Map<WorkspaceLeaf, Shown>();
	const follows = new CursorFollow(plugin);
	plugin.register(() => follows.stop());
	let frame: number | null = null;
	let settle: number | null = null;

	const render = (): void => {
		frame = null;
		const now = Date.now();
		const seen = new Set<WorkspaceLeaf>();
		workspace.iterateAllLeaves((leaf) => {
			const header = headerOf(plugin, leaf);
			if (!header) return;
			const actions = header.view.containerEl.querySelector<HTMLElement>(
				".view-header .view-actions",
			);
			if (!actions) return;
			seen.add(leaf);
			const { state, file } = header;
			let entry = shown.get(leaf);
			if (entry?.el.parentElement !== actions) {
				entry?.el.remove();
				const el = createHeader(plugin, leaf, actions, follows);
				entry = { el, key: "", path: file.path, since: now };
				shown.set(leaf, entry);
			}
			if (entry.path !== file.path) {
				entry.path = file.path;
				entry.since = now;
				// The last note's people stay off the next one while it settles.
				entry.key = "";
				entry.el.empty();
				entry.el.addClass("obsync-hidden");
			}
			if (isPassing(state) && now - entry.since < SETTLE_MS) {
				settle ??= window.setTimeout(() => {
					settle = null;
					schedule();
				}, SETTLE_MS);
				return;
			}
			const key = JSON.stringify(state);
			if (entry.key === key) return;
			entry.key = key;
			fillHeader(entry.el, state);
		});
		for (const [leaf, { el }] of shown) {
			if (seen.has(leaf)) continue;
			el.remove();
			shown.delete(leaf);
		}
	};
	const schedule = (): void => {
		frame ??= window.requestAnimationFrame(render);
	};

	plugin.register(people.subscribe(schedule));
	plugin.register(live.subscribe(schedule));
	// A compare may leave the open file out of the sync, or take it back.
	plugin.register(plugin.controller.subscribe(schedule));
	plugin.register(watchReadOnlyRoots(plugin, schedule));
	plugin.registerEvent(plugin.app.vault.on("rename", schedule));
	plugin.registerEvent(workspace.on("layout-change", schedule));
	plugin.registerEvent(workspace.on("file-open", schedule));
	workspace.onLayoutReady(schedule);
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
		if (settle !== null) window.clearTimeout(settle);
		for (const { el } of shown.values()) el.remove();
		shown.clear();
	});
	return (checking) => openActiveNoteMenu(plugin, follows, checking);
}

function createHeader(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	actions: HTMLElement,
	follows: CursorFollow,
): HTMLElement {
	// Not `clickable-icon`: themes size those to one icon, and avatars spill out.
	const el = actions.createSpan({ cls: "obsync-note-presence obsync-hidden" });
	actions.prepend(el);
	makeActivatable(el, null, () => openNoteMenu(plugin, leaf, follows, el));
	return el;
}

/** On the way to live, or not there yet: the room has not answered. */
function isPassing({ status }: HeaderState): boolean {
	return status?.state === "joining" || status?.state === "cold";
}

function fillHeader(el: HTMLElement, state: HeaderState): void {
	const { status, here, locked } = state;
	el.empty();
	el.toggleClass("obsync-hidden", !showsHeader(state));
	if (locked) setIcon(el.createSpan({ cls: "obsync-note-lock" }), "lock");
	if (status) {
		const icon = el.createSpan({ cls: `obsync-note-state is-${status.state}` });
		setIcon(icon, STATE_ICONS[status.state]);
	}
	if (here.length > 0) renderAvatarStack(el, here);
	const lines = [locked ? LOCKED : undefined, status?.label];
	if (here.length > 0) lines.push(`Here: ${describePeople(here)}`);
	el.setAttr("aria-label", lines.filter(Boolean).join("\n"));
}
