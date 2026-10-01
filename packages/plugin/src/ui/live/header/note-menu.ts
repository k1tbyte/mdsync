import { MarkdownView, Menu, type WorkspaceLeaf } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import {
	infoTitle,
	lastEditLabel,
	openRelaySettings,
	personTitle,
	relayFixOf,
	showMenuAt,
} from "@/ui/common";
import { openShareWindow } from "@/ui/shares/share-window";
import type { CursorFollow } from "./cursor-follow";
import { headerOf, showsHeader } from "./header-state";
import { rebuildLiveNote, toggleAuthors } from "./live-actions";
import {
	actionItems,
	infoItems,
	type MenuFacts,
	type MenuItem,
	type NoteAction,
	personState,
} from "./note-menu-items";

export function openActiveNoteMenu(
	plugin: PluginHost,
	follows: CursorFollow,
	checking: boolean,
): boolean {
	const leaf = plugin.app.workspace.getMostRecentLeaf();
	const header = leaf && headerOf(plugin, leaf);
	if (!leaf || !header || !showsHeader(header.state)) return false;
	if (!checking) openNoteMenu(plugin, leaf, follows);
	return true;
}

/** Read when opened: the header may be a frame behind. */
export function openNoteMenu(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	follows: CursorFollow,
	anchor?: HTMLElement,
): void {
	const header = headerOf(plugin, leaf);
	if (!header) return;
	const { view, file, space, state } = header;
	const { status, here, locked } = state;
	const { live, hub } = plugin.realtime;
	const record = plugin.spaces.shareOf(space);
	const liveText =
		view instanceof MarkdownView && live.roomOf(file.path) !== null;
	const facts: MenuFacts = {
		locked,
		status,
		edited: lastEditLabel(plugin, file.path),
		relayFix: relayFixOf(hub.statusOf(space.id)),
		shared: record !== undefined,
		liveText,
		authorsShown: plugin.settings.showLiveAuthors,
	};
	const run: Record<NoteAction, () => void> = {
		authors: () => toggleAuthors(plugin),
		reconnect: () => plugin.realtime.hub.reconnect(space.id),
		"relay-settings": () => openRelaySettings(plugin.app),
		manage: () => record && openShareWindow(plugin, record),
		rebuild: () => rebuildLiveNote(plugin, file.path),
	};
	const menu = new Menu();
	const info = infoItems(facts);
	const actions = actionItems(facts);
	addItems(menu, info, run);
	if (info.length > 0 && here.length > 0) menu.addSeparator();
	const followed = follows.of(leaf);
	for (const person of here) {
		const following = followed === person.key;
		menu.addItem((item) => {
			item.setTitle(
				personTitle(person, personState({ idle: person.idle, following })),
			);
			if (following) item.setChecked(true).onClick(() => follows.stop());
			else item.onClick(() => follows.start(leaf, space.id, person));
		});
	}
	if (actions.length > 0 && info.length + here.length > 0) {
		menu.addSeparator();
	}
	addItems(menu, actions, run);
	showMenuAt(menu, anchor, view.containerEl);
}

function addItems(
	menu: Menu,
	items: readonly MenuItem[],
	run: Record<NoteAction, () => void>,
): void {
	for (const { title, icon, checked, action } of items) {
		menu.addItem((item) => {
			item.setIcon(icon);
			if (checked !== undefined) item.setChecked(checked);
			if (action) item.setTitle(title).onClick(run[action]);
			else item.setTitle(infoTitle(title)).setIsLabel(true);
		});
	}
}
