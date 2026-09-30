import type { Plugin } from "obsidian";

import type { LinkState } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import { makeActivatable } from "@/ui/common/activatable";
import { setIndicatorTooltip } from "@/ui/explorer/indicator-tooltip";
import { describePeople, renderAvatarStack } from "./avatars";
import { carried, inSharedNotes, isConnected } from "./live-spaces";
import { RELAY_TEXT, relaySummary, UNREADABLE_TEXT } from "./relay-text";
import { openWhereMenu } from "./where-menu";

/** Desktop only, as every status bar item: whether the relay carries each space, and who is in the shared folders. */
export function registerLiveStatusBar(plugin: Plugin & PluginHost): void {
	const { people } = plugin.realtime;
	const root = plugin.addStatusBarItem();
	root.addClass("obsync-live-status", "mod-clickable");
	let frame: number | null = null;

	const render = (): void => {
		frame = null;
		root.empty();
		const spaces = carried(plugin);
		root.toggleClass("obsync-hidden", spaces.length === 0);
		if (spaces.length === 0) return;
		const statuses = spaces.map(({ status }) => status);
		const unreadable = spaces.some(({ id }) => people.unreadable(id));
		const here = inSharedNotes(plugin);
		root.createSpan({
			cls: `obsync-live-dot ${statuses.every(isConnected) ? "is-live" : "is-offline"}`,
		});
		root.createSpan({ text: relaySummary(statuses, unreadable) });
		if (here.length > 0) renderAvatarStack(root, here);
		const where =
			here.length > 0 ? `In shared notes: ${describePeople(here)}` : null;
		setIndicatorTooltip(
			root,
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
