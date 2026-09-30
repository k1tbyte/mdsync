import { Menu } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { VAULT_SPACE } from "@/sync/space";
import { renderAvatar } from "./avatars";
import { lastEditLabel } from "./last-edit";
import { carried, inSharedNotes, isConnected, spaceName } from "./live-spaces";
import { LINK_LIVE_STATE, STATE_ICONS } from "./live-status";
import { infoTitle } from "./menu-info";
import { showMenuAt } from "./menu-position";
import { RELAY_TEXT, UNREADABLE_TEXT } from "./relay-text";

export function openWhereMenu(plugin: PluginHost, anchor?: HTMLElement): void {
	const menu = new Menu();
	addStatuses(menu, plugin);
	menu.addSeparator();
	const here = inSharedNotes(plugin);
	if (here.length === 0) {
		menu.addItem((item) =>
			item.setTitle(infoTitle("Nobody is in a shared note")).setIsLabel(true),
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
	addUnseen(menu, plugin);
	const { workspace } = plugin.app;
	const view = workspace.getMostRecentLeaf()?.view;
	showMenuAt(menu, anchor, view?.containerEl ?? workspace.containerEl);
}

function addStatuses(menu: Menu, plugin: PluginHost): void {
	const spaces = carried(plugin);
	if (spaces.length === 0) {
		menu.addItem((item) =>
			item
				.setTitle(
					infoTitle(RELAY_TEXT[plugin.realtime.statusOf(VAULT_SPACE.id)]),
				)
				.setIcon(STATE_ICONS.cold)
				.setIsLabel(true),
		);
		return;
	}
	for (const { id, status } of spaces) {
		const unreadable =
			isConnected(status) && plugin.realtime.people.unreadable(id);
		menu.addItem((item) =>
			item
				.setTitle(
					infoTitle(
						spaceName(plugin, id),
						unreadable ? UNREADABLE_TEXT : RELAY_TEXT[status],
					),
				)
				.setIcon(
					unreadable
						? STATE_ICONS.offline
						: STATE_ICONS[LINK_LIVE_STATE[status]],
				)
				.setIsLabel(true),
		);
	}
}

function addUnseen(menu: Menu, plugin: PluginHost): void {
	const notes = [...plugin.unseen.all()].filter((path) =>
		plugin.app.vault.getFileByPath(path),
	);
	const latest = notes.at(-1);
	if (latest === undefined) return;
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle(infoTitle(`${notes.length} changed by others`))
			.setIcon("dot")
			.setIsLabel(true),
	);
	const edited = lastEditLabel(plugin, latest);
	if (edited) {
		menu.addItem((item) =>
			item.setTitle(infoTitle(edited)).setIcon("pencil").setIsLabel(true),
		);
	}
}

function whereTitle(person: Person, note: string): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	title.createSpan({ cls: "obsync-person-state", text: note });
	return title;
}
