import type { Menu } from "obsidian";
import {
	FULL_SHORT_TEXT,
	isConnected,
	LINK_TEXT,
	type LinkState,
	RELAY_TEXT,
	relayFixOf,
	UNREADABLE_TEXT,
} from "@/core/hub";
import { infoTitle, openNote, openPluginSettings } from "@/core/ui";
import { LINK_LIVE_STATE, STATE_ICONS } from "@/features/live";
import { personTitle } from "@/features/presence";
import { lastEditLabel, openShareWindow } from "@/features/spaces";
import { VAULT_SPACE } from "@/features/sync";
import type { StatusHost } from "./host";
import {
	type CarriedSpace,
	carried,
	inSharedNotes,
	type RelayGroup,
	relayGroups,
	sharesConnected,
	spaceName,
} from "./live-spaces";

/** The relay of every space, its fixes, who is in shared notes and what others changed. */
export function addRelaySections(menu: Menu, plugin: StatusHost): void {
	const spaces = carried(plugin);
	addStatuses(menu, plugin, spaces);
	addRelayFixes(menu, plugin, spaces);
	menu.addSeparator();
	const here = inSharedNotes(plugin);
	if (here.length === 0 && sharesConnected(spaces)) {
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
}

function addStatuses(
	menu: Menu,
	plugin: StatusHost,
	spaces: readonly CarriedSpace[],
): void {
	const groups = relayGroups(plugin);
	if (spaces.length === 0 || groups.length === 0) {
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
	for (const group of groups) addGroup(menu, plugin, group);
}

/** The relay, then the folders on its one socket, hung from its icon by a rail; a share opens its window. */
function addGroup(menu: Menu, plugin: StatusHost, group: RelayGroup): void {
	const { name, state, spaces, full } = group;
	const head = createFragment();
	head.createSpan({ cls: "mdsync-menu-info mdsync-relay-name", text: name });
	head.createSpan({ cls: "mdsync-person-state", text: LINK_TEXT[state] });
	menu.addItem((item) =>
		item
			.setTitle(head)
			.setIcon(STATE_ICONS[LINK_LIVE_STATE[state]])
			.setIsLabel(true),
	);
	const members = [
		...spaces.map(({ id, status }) => ({
			id,
			note: memberNote(plugin, id, status, state),
		})),
		...full.map((id) => ({ id, note: FULL_SHORT_TEXT })),
	];
	members.forEach(({ id, note }, at) => {
		const title = createFragment();
		const row = title.createSpan({ cls: "mdsync-relay-member" });
		row.toggleClass("is-last", at === members.length - 1);
		row.toggleClass("is-trouble", note !== null);
		row.createSpan({ cls: "mdsync-menu-info", text: spaceName(plugin, id) });
		if (note) row.createSpan({ cls: "mdsync-person-state", text: note });
		const record = id === VAULT_SPACE.id ? undefined : plugin.spaces.get(id);
		menu.addItem((item) => {
			item.setTitle(title);
			if (record) item.onClick(() => openShareWindow(plugin, record));
			else item.setIsLabel(true);
		});
	});
}

/** Said only where a folder differs from its relay: the socket's word covers the rest. */
function memberNote(
	plugin: StatusHost,
	id: string,
	status: LinkState,
	socket: LinkState,
): string | null {
	if (status !== socket) return LINK_TEXT[status];
	if (isConnected(status) && plugin.realtime.people.unreadable(id)) {
		return UNREADABLE_TEXT;
	}
	return null;
}

function addRelayFixes(
	menu: Menu,
	plugin: StatusHost,
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
				.onClick(() => openPluginSettings(plugin.app)),
		);
	}
}

function addUnseen(menu: Menu, plugin: StatusHost): void {
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
