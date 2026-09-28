import { Menu, type Plugin } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { VAULT_SPACE } from "@/sync/space";

import { describePeople, renderAvatar, renderAvatarStack } from "./avatars";
import { setIndicatorTooltip } from "./indicator-tooltip";

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
		const down = spaces.filter((id) => !people.connected(id)).length;
		const here = inSharedNotes(plugin);
		root.createSpan({
			cls: `obsync-live-dot ${down === 0 ? "is-live" : "is-offline"}`,
		});
		root.createSpan({ text: describeRelay(down, spaces.length) });
		if (here.length > 0) renderAvatarStack(root, here);
		const where =
			here.length > 0 ? `In shared notes: ${describePeople(here)}` : null;
		setIndicatorTooltip(
			root,
			[relayTooltip(down), where].filter(Boolean).join("\n"),
		);
	};
	const schedule = (): void => {
		frame ??= window.requestAnimationFrame(render);
	};

	root.addEventListener("click", (event) => openWhereMenu(plugin, event));
	plugin.register(people.subscribe(schedule));
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
	});
	schedule();
}

function carried(plugin: PluginHost): string[] {
	return plugin.spaces
		.partition()
		.map(({ id }) => id)
		.filter((id) => plugin.realtime.hub.carries(id));
}

/** People with a shared note open and at it; the vault's own devices are not people here. */
function inSharedNotes(plugin: PluginHost): Person[] {
	const byKey = new Map<string, Person>();
	for (const id of carried(plugin)) {
		if (id === VAULT_SPACE.id) continue;
		for (const person of plugin.realtime.people.online(id)) {
			if (person.note !== null && !person.idle) {
				byKey.set(`${id}|${person.key}`, person);
			}
		}
	}
	return [...byKey.values()];
}

function describeRelay(down: number, total: number): string {
	if (down === 0) return "Live";
	if (down === total) return "Relay offline";
	return `Live, ${down} offline`;
}

function relayTooltip(down: number): string {
	return down === 0
		? "Relay connected: changes reach the others at once"
		: "Some shared folders cannot reach their relay: they sync on the schedule";
}

function openWhereMenu(plugin: PluginHost, event: MouseEvent): void {
	const here = inSharedNotes(plugin);
	const menu = new Menu();
	if (here.length === 0) {
		menu.addItem((item) =>
			item.setTitle("Nobody is in a shared note").setDisabled(true),
		);
	}
	for (const person of here) {
		const note = person.note ?? "";
		menu.addItem((item) =>
			item.setTitle(whereTitle(person, note)).onClick(() => {
				const file = plugin.app.vault.getFileByPath(note);
				if (file) void plugin.app.workspace.getLeaf(false).openFile(file);
			}),
		);
	}
	menu.showAtMouseEvent(event);
}

function whereTitle(person: Person, note: string): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	title.createSpan({ cls: "obsync-person-state", text: note });
	return title;
}
