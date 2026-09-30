import { Menu } from "obsidian";

import { isConnected } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import { VAULT_SPACE } from "@/sync/space";
import {
	infoTitle,
	lastEditLabel,
	openNote,
	openRelaySettings,
	personTitle,
	RELAY_TEXT,
	relayFixOf,
	showMenuAt,
	UNREADABLE_TEXT,
} from "@/ui/common";
import { LINK_LIVE_STATE, STATE_ICONS } from "@/ui/live/live-state";
import {
	type CarriedSpace,
	carried,
	inSharedNotes,
	spaceName,
} from "./live-spaces";

export function openWhereMenu(plugin: PluginHost, anchor?: HTMLElement): void {
	const menu = new Menu();
	const spaces = carried(plugin);
	addStatuses(menu, plugin, spaces);
	addRelayFixes(menu, plugin, spaces);
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
			item
				.setTitle(personTitle(person, note))
				.onClick(() => void openNote(plugin.app, note)),
		);
	}
	addUnseen(menu, plugin);
	const { workspace } = plugin.app;
	const view = workspace.getMostRecentLeaf()?.view;
	showMenuAt(menu, anchor, view?.containerEl ?? workspace.containerEl);
}

function addStatuses(
	menu: Menu,
	plugin: PluginHost,
	spaces: readonly CarriedSpace[],
): void {
	if (spaces.length === 0) {
		menu.addItem((item) =>
			item
				.setTitle(
					infoTitle(RELAY_TEXT[plugin.realtime.hub.statusOf(VAULT_SPACE.id)]),
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
				.setIcon(STATE_ICONS[unreadable ? "warning" : LINK_LIVE_STATE[status]])
				.setIsLabel(true),
		);
	}
}

function addRelayFixes(
	menu: Menu,
	plugin: PluginHost,
	spaces: readonly CarriedSpace[],
): void {
	const unreachable = spaces.filter(
		({ status }) => relayFixOf(status) === "reconnect",
	);
	const refused = spaces.some(
		({ status }) => relayFixOf(status) === "settings",
	);
	if (unreachable.length === 0 && !refused) return;
	menu.addSeparator();
	if (unreachable.length > 0) {
		menu.addItem((item) =>
			item
				.setTitle("Reconnect")
				.setIcon("refresh-cw")
				.onClick(() => {
					for (const { id } of unreachable) plugin.realtime.hub.reconnect(id);
				}),
		);
	}
	if (refused) {
		menu.addItem((item) =>
			item
				.setTitle("Open relay settings")
				.setIcon("settings")
				.onClick(() => openRelaySettings(plugin.app)),
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
