import { MarkdownView, Menu, type Plugin, type WorkspaceLeaf } from "obsidian";

import type { RelayStatus } from "@/hub/status";
import type { LiveSession } from "@/live/session";
import { cursorsIn, watchCursor } from "@/live/text/cursors";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { openShareWindow } from "@/ui/shares/share-window";
import { renderAvatar } from "./avatars";
import type { CursorFollow } from "./cursor-follow";
import { headerOf, showsHeader } from "./header-state";
import { lastEditLabel } from "./last-edit";
import { rebuildLiveNote, sharedFolderOf, toggleAuthors } from "./live-actions";
import { infoTitle } from "./menu-info";
import { showMenuAt } from "./menu-position";
import {
	actionItems,
	infoItems,
	type MenuFacts,
	type MenuItem,
	type NoteAction,
	personState,
} from "./note-menu-items";

const RELAY_DOWN: readonly RelayStatus[] = ["offline", "unauthorized"];

export function registerNoteMenuCommand(
	plugin: Plugin & PluginHost,
	follows: CursorFollow,
): void {
	plugin.addCommand({
		id: "show-note-live-menu",
		name: "Show live menu of this note",
		checkCallback: (checking) => openActiveNoteMenu(plugin, follows, checking),
	});
}

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
	const { live, statusOf } = plugin.realtime;
	const record = sharedFolderOf(plugin, space);
	const session = live.roomOf(file.path);
	const markdown = view instanceof MarkdownView;
	const cursors = session && markdown ? cursorsIn(session) : [];
	const facts: MenuFacts = {
		locked,
		status,
		edited: lastEditLabel(plugin, file.path),
		relayDown: RELAY_DOWN.includes(statusOf(space.id)),
		shared: record !== undefined,
		liveText: session !== null && markdown,
		authorsShown: plugin.settings.showLiveAuthors,
	};
	const run: Record<NoteAction, () => void> = {
		authors: () => toggleAuthors(plugin),
		reconnect: () => plugin.realtime.hub.reconnect(space.id),
		manage: () => record && openShareWindow(plugin, record),
		rebuild: () => rebuildLiveNote(plugin, file.path),
	};
	const menu = new Menu();
	const info = infoItems(facts);
	const actions = actionItems(facts);
	addItems(menu, info, run);
	if (info.length > 0 && here.length > 0) menu.addSeparator();
	const followed =
		session && markdown
			? follows.of(session, (view as MarkdownView).editor)
			: null;
	for (const person of here) {
		const at = cursors.find(({ key }) => key === person.key)?.at ?? null;
		const following = followed === person.key;
		menu.addItem((item) => {
			item.setTitle(personTitle(person, at !== null, markdown, following));
			if (following) item.setChecked(true).onClick(() => follows.stop());
			else if (at === null || !session) item.setDisabled(true);
			else {
				item.onClick(() =>
					follow(
						plugin,
						leaf,
						view as MarkdownView,
						session,
						person.key,
						at,
						follows,
					),
				);
			}
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

function personTitle(
	person: Person,
	hasCursor: boolean,
	cursorsShared: boolean,
	following: boolean,
): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	title.createSpan({
		cls: "obsync-person-state",
		text: personState(person, hasCursor, cursorsShared, following),
	});
	return title;
}

/** Goes to their cursor, then keeps it in view as it moves. */
function follow(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	view: MarkdownView,
	session: LiveSession,
	key: string,
	offset: number,
	follows: CursorFollow,
): void {
	const { editor, file } = view;
	const at = editor.offsetToPos(offset);
	plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
	editor.setCursor(at);
	editor.scrollIntoView({ from: at, to: at }, true);
	follows.start({
		room: session,
		key,
		editor,
		input: view.contentEl,
		cursor: watchCursor(session, key),
		shown: () =>
			leaf.view === view &&
			view.file === file &&
			file !== null &&
			plugin.realtime.live.roomOf(file.path) === session,
	});
}
