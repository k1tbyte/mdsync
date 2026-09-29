import { FileView, MarkdownView, Menu, type WorkspaceLeaf } from "obsidian";

import type { RelayStatus } from "@/hub/status";
import { cursorsIn } from "@/live/text/cursors";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { spaceOf } from "@/sync/space";
import { openShareWindow } from "@/ui/shares/share-window";
import { renderAvatar } from "./avatars";
import { headerStateOf } from "./header-state";
import { lastEditLabel } from "./last-edit";
import { rebuildLiveNote, sharedFolderOf, toggleAuthors } from "./live-actions";
import {
	actionItems,
	infoItems,
	type MenuFacts,
	type MenuItem,
	type NoteAction,
	personState,
} from "./note-menu-items";

const RELAY_DOWN: readonly RelayStatus[] = ["offline", "unauthorized"];

/** Read when opened: the header may be a frame behind. */
export function openNoteMenu(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	anchor: HTMLElement,
): void {
	const { view } = leaf;
	if (!(view instanceof FileView) || !view.file) return;
	const file = view.file;
	const { status, here, locked } = headerStateOf(plugin, view, file);
	const { live, statusOf } = plugin.realtime;
	const space = spaceOf(plugin.spaces.partition(), file.path);
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
		authorsShown: live.authorsShown(),
	};
	const run: Record<NoteAction, () => void> = {
		authors: () => toggleAuthors(plugin),
		reconnect: () => plugin.realtime.hub.restart(),
		manage: () => record && openShareWindow(plugin, record),
		rebuild: () => rebuildLiveNote(plugin, file.path),
	};
	const menu = new Menu();
	const info = infoItems(facts);
	const actions = actionItems(facts);
	addItems(menu, info, run);
	if (info.length > 0 && here.length > 0) menu.addSeparator();
	for (const person of here) {
		const at = cursors.find(({ key }) => key === person.key)?.at ?? null;
		menu.addItem((item) => {
			item.setTitle(personTitle(person, at !== null, markdown));
			if (at === null) item.setDisabled(true);
			else item.onClick(() => jumpTo(plugin, leaf, view as MarkdownView, at));
		});
	}
	if (actions.length > 0 && info.length + here.length > 0) {
		menu.addSeparator();
	}
	addItems(menu, actions, run);
	const { left, bottom } = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: left, y: bottom });
}

function addItems(
	menu: Menu,
	items: readonly MenuItem[],
	run: Record<NoteAction, () => void>,
): void {
	for (const { title, icon, checked, action } of items) {
		menu.addItem((item) => {
			item.setTitle(title).setIcon(icon);
			if (checked !== undefined) item.setChecked(checked);
			if (action) item.onClick(run[action]);
			else item.setDisabled(true);
		});
	}
}

function personTitle(
	person: Person,
	hasCursor: boolean,
	cursorsShared: boolean,
): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	title.createSpan({
		cls: "obsync-person-state",
		text: personState(person, hasCursor, cursorsShared),
	});
	return title;
}

function jumpTo(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	view: MarkdownView,
	offset: number,
): void {
	const { editor } = view;
	const at = editor.offsetToPos(offset);
	plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
	editor.setCursor(at);
	editor.scrollIntoView({ from: at, to: at }, true);
}
