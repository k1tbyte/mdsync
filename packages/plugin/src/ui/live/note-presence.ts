import { type Plugin, setIcon, type WorkspaceLeaf } from "obsidian";

import { watchReadOnlyRoots } from "@/editor/read-only";
import type { PluginHost } from "@/plugin/host";
import { makeActivatable } from "@/ui/common/activatable";
import { setIndicatorTooltip } from "@/ui/explorer/indicator-tooltip";
import { describePeople, renderAvatarStack } from "./avatars";
import { CursorFollow } from "./cursor-follow";
import { type HeaderState, headerOf, showsHeader } from "./header-state";
import { STATE_ICONS } from "./live-status";
import { openNoteMenu, registerNoteMenuCommand } from "./note-menu";
import { LOCKED } from "./note-menu-items";

interface Shown {
	el: HTMLElement;
	/** What it shows, so an unchanged header is not redrawn. */
	key: string;
}

/** Who else has each open file, and whether it is live, in its view header. */
export function registerNotePresence(plugin: Plugin & PluginHost): void {
	const { workspace } = plugin.app;
	const { people, live } = plugin.realtime;
	const shown = new Map<WorkspaceLeaf, Shown>();
	const follows = new CursorFollow();
	plugin.register(() => follows.stop());
	registerNoteMenuCommand(plugin, follows);
	let frame: number | null = null;

	const render = (): void => {
		frame = null;
		const seen = new Set<WorkspaceLeaf>();
		workspace.iterateAllLeaves((leaf) => {
			const header = headerOf(plugin, leaf);
			if (!header) return;
			const actions = header.view.containerEl.querySelector<HTMLElement>(
				".view-header .view-actions",
			);
			if (!actions) return;
			seen.add(leaf);
			const { state } = header;
			const key = JSON.stringify(state);
			let entry = shown.get(leaf);
			if (entry?.el.parentElement === actions && entry.key === key) return;
			if (entry?.el.parentElement !== actions) {
				entry?.el.remove();
				entry = { el: createHeader(plugin, leaf, actions, follows), key };
				shown.set(leaf, entry);
			}
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
	plugin.register(watchReadOnlyRoots(plugin, schedule));
	plugin.registerEvent(plugin.app.vault.on("rename", schedule));
	plugin.registerEvent(workspace.on("layout-change", schedule));
	plugin.registerEvent(workspace.on("file-open", schedule));
	workspace.onLayoutReady(schedule);
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
		for (const { el } of shown.values()) el.remove();
		shown.clear();
	});
}

function createHeader(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	actions: HTMLElement,
	follows: CursorFollow,
): HTMLElement {
	const el = actions.createSpan({ cls: "obsync-note-presence clickable-icon" });
	actions.prepend(el);
	makeActivatable(el, null, () => openNoteMenu(plugin, leaf, follows, el));
	return el;
}

function fillHeader(el: HTMLElement, state: HeaderState): void {
	const { status, here, locked } = state;
	el.empty();
	el.toggleClass("obsync-hidden", !showsHeader(state));
	if (locked) setIcon(el.createSpan({ cls: "obsync-note-lock" }), "lock");
	if (status) {
		el.createSpan({ cls: `obsync-live-dot is-${status.state}` });
		const icon = el.createSpan({ cls: "obsync-note-state" });
		setIcon(icon, STATE_ICONS[status.state]);
	}
	if (here.length > 0) renderAvatarStack(el, here);
	const lines = [locked ? LOCKED : undefined, status?.label];
	if (here.length > 0) lines.push(`Here: ${describePeople(here)}`);
	setIndicatorTooltip(el, lines.filter(Boolean).join("\n"));
}
