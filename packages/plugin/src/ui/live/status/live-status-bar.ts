import type { Plugin } from "obsidian";

import { isConnected, type LinkState } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import {
	describePeople,
	makeActivatable,
	RELAY_TEXT,
	relaySummary,
	renderAvatarStack,
	UNREADABLE_TEXT,
} from "@/ui/common";
import { carried, inSharedNotes } from "./live-spaces";
import { openWhereMenu } from "./where-menu";

/** Desktop only: the relay link of every space it carries, and who is in shared notes. */
export function registerLiveStatusBar(plugin: Plugin & PluginHost): void {
	const { people } = plugin.realtime;
	const root = plugin.addStatusBarItem();
	root.addClass("mdsync-live-status", "mod-clickable");
	let frame: number | null = null;
	/** What the bar shows: presence emits on every announcement, most change nothing here. */
	let shown: string | null = null;

	const render = (): void => {
		frame = null;
		const spaces = carried(plugin);
		const statuses = spaces.map(({ status }) => status);
		const unreadable = spaces.some(({ id }) => people.unreadable(id));
		const here = inSharedNotes(plugin);
		const key = JSON.stringify([statuses, unreadable, here]);
		if (key === shown) return;
		shown = key;
		root.empty();
		root.toggleClass("mdsync-hidden", spaces.length === 0);
		if (spaces.length === 0) return;
		root.createSpan({
			cls: `mdsync-live-dot ${statuses.every(isConnected) ? "is-live" : "is-offline"}`,
		});
		root.createSpan({ text: relaySummary(statuses, unreadable) });
		if (here.length > 0) renderAvatarStack(root, here);
		const where =
			here.length > 0 ? `In shared notes: ${describePeople(here)}` : null;
		root.setAttr(
			"aria-label",
			[...relayTooltip(statuses), unreadable ? UNREADABLE_TEXT : null, where]
				.filter(Boolean)
				.join("\n"),
		);
	};
	const schedule = (): void => {
		frame ??= window.requestAnimationFrame(render);
	};

	makeActivatable(root, null, () => openWhereMenu(plugin, root));
	plugin.register(people.subscribe(schedule));
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
	schedule();
}

function relayTooltip(statuses: readonly LinkState[]): string[] {
	if (statuses.every(isConnected)) {
		return ["Relay connected: changes reach the others at once"];
	}
	return [...new Set(statuses.filter((status) => !isConnected(status)))].map(
		(status) => RELAY_TEXT[status],
	);
}
