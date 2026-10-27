import type { Plugin } from "obsidian";
import {
	isConnected,
	type LinkState,
	RELAY_TEXT,
	relaySummary,
	UNREADABLE_TEXT,
} from "@/core/hub";
import type { Person } from "@/features/presence";
import { describePeople, renderAvatarStack } from "@/features/presence";
import type { StatusHost } from "./host";
import { carried, inSharedNotes } from "./live-spaces";

/** The status bar's relay half: one dot for the link of every space it carries, and who is in shared notes. */
export function mountRelayStatus(
	plugin: Plugin & StatusHost,
	el: HTMLElement,
	onChange: () => void,
): void {
	const { people } = plugin.realtime;
	let frame: number | null = null;
	/** What it shows: presence emits on every announcement, most change nothing here. */
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
		el.empty();
		el.toggleClass("mdsync-hidden", spaces.length === 0);
		if (spaces.length > 0) draw(el, statuses, unreadable, here);
		onChange();
	};
	const schedule = (): void => {
		frame ??= window.requestAnimationFrame(render);
	};

	plugin.register(people.subscribe(schedule));
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
	schedule();
}

function draw(
	el: HTMLElement,
	statuses: readonly LinkState[],
	unreadable: boolean,
	here: readonly Person[],
): void {
	const live = statuses.every(isConnected);
	el.createSpan({ cls: `mdsync-live-dot ${live ? "is-live" : "is-offline"}` });
	// A working relay is the dot alone; trouble is named.
	if (!live || unreadable) {
		el.createSpan({ text: relaySummary(statuses, unreadable) });
	}
	if (here.length > 0) renderAvatarStack(el, here);
	const where =
		here.length > 0 ? `In shared notes: ${describePeople(here)}` : null;
	el.setAttr(
		"aria-label",
		[...relayTooltip(statuses), unreadable ? UNREADABLE_TEXT : null, where]
			.filter(Boolean)
			.join("\n"),
	);
}

function relayTooltip(statuses: readonly LinkState[]): string[] {
	if (statuses.every(isConnected)) {
		return ["Relay connected: changes reach the others at once"];
	}
	return [...new Set(statuses.filter((status) => !isConnected(status)))].map(
		(status) => RELAY_TEXT[status],
	);
}
