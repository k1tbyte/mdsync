import {
	FileView,
	MarkdownView,
	Menu,
	type Plugin,
	setIcon,
	type WorkspaceLeaf,
} from "obsidian";

import { watchReadOnlyRoots } from "@/editor/read-only";
import { cursorsIn } from "@/live/cursors";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { spaceOf } from "@/sync/space";

import { describePeople, renderAvatar, renderAvatarStack } from "./avatars";
import { setIndicatorTooltip } from "./indicator-tooltip";
import { lastEditLabel } from "./last-edit";
import { type LiveState, type LiveStatus, liveStatusOf } from "./live-status";

const STATE_ICONS: Record<LiveState, string> = {
	live: "radio",
	joining: "loader",
	offline: "wifi-off",
	cold: "circle-dashed",
};

const LOCKED = "Read-only: shared with you to read";

interface HeaderState {
	status: LiveStatus | null;
	here: readonly Person[];
	/** In a read-only share, so the editor takes no typing. */
	locked: boolean;
}

interface Shown {
	el: HTMLElement;
	/** What it shows, so an unchanged header is not redrawn. */
	key: string;
}

/** Who else has each open file, and whether it is live, in its view header. */
export function registerNotePresence(plugin: Plugin & PluginHost): void {
	const { workspace } = plugin.app;
	const { people, live } = plugin.realtime;
	const shown = new Map<WorkspaceLeaf, Shown>();
	let frame: number | null = null;

	const render = (): void => {
		frame = null;
		const seen = new Set<WorkspaceLeaf>();
		workspace.iterateAllLeaves((leaf) => {
			const { view } = leaf;
			if (!(view instanceof FileView) || !view.file) return;
			const actions = view.containerEl.querySelector<HTMLElement>(
				".view-header .view-actions",
			);
			if (!actions) return;
			seen.add(leaf);
			const state: HeaderState = {
				status: liveStatusOf(plugin, view, view.file),
				here: people.inNote(view.file.path),
				locked:
					spaceOf(plugin.spaces.partition(), view.file.path).readOnly === true,
			};
			const key = JSON.stringify(state);
			let entry = shown.get(leaf);
			if (entry?.el.parentElement === actions && entry.key === key) return;
			if (entry?.el.parentElement !== actions) {
				entry?.el.remove();
				entry = { el: createHeader(plugin, leaf, actions), key };
				shown.set(leaf, entry);
			}
			entry.key = key;
			fillHeader(entry.el, state);
		});
		for (const [leaf, { el }] of shown) {
			if (seen.has(leaf)) continue;
			el.remove();
			shown.delete(leaf);
		}
	};
	const schedule = (): void => {
		frame ??= window.requestAnimationFrame(render);
	};

	plugin.register(people.subscribe(schedule));
	plugin.register(live.subscribe(schedule));
	plugin.register(watchReadOnlyRoots(plugin, schedule));
	plugin.registerEvent(plugin.app.vault.on("rename", schedule));
	plugin.registerEvent(workspace.on("layout-change", schedule));
	plugin.registerEvent(workspace.on("file-open", schedule));
	workspace.onLayoutReady(schedule);
	plugin.register(() => {
		if (frame !== null) window.cancelAnimationFrame(frame);
		for (const { el } of shown.values()) el.remove();
		shown.clear();
	});
}

function createHeader(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	actions: HTMLElement,
): HTMLElement {
	const el = actions.createSpan({
		cls: "obsync-note-presence clickable-icon",
		attr: { role: "button", tabindex: "0" },
	});
	actions.prepend(el);
	el.addEventListener("click", () => openMenu(plugin, leaf, el));
	el.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		openMenu(plugin, leaf, el);
	});
	return el;
}

function fillHeader(
	el: HTMLElement,
	{ status, here, locked }: HeaderState,
): void {
	el.empty();
	el.toggleClass(
		"obsync-hidden",
		status === null && here.length === 0 && !locked,
	);
	if (locked) setIcon(el.createSpan({ cls: "obsync-note-lock" }), "lock");
	if (status) el.createSpan({ cls: `obsync-live-dot is-${status.state}` });
	if (here.length > 0) renderAvatarStack(el, here);
	const lines = [locked ? LOCKED : undefined, status?.label];
	if (here.length > 0) lines.push(`Here: ${describePeople(here)}`);
	setIndicatorTooltip(el, lines.filter(Boolean).join("\n"));
}

/** Read when opened: the header may be a frame behind. */
function openMenu(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
	anchor: HTMLElement,
): void {
	const { view } = leaf;
	if (!(view instanceof FileView) || !view.file) return;
	const file = view.file;
	const status = liveStatusOf(plugin, view, file);
	const here = plugin.realtime.people.inNote(file.path);
	const session = plugin.realtime.live.roomOf(file.path);
	const cursors =
		session && view instanceof MarkdownView ? cursorsIn(session) : [];
	const menu = new Menu();
	if (spaceOf(plugin.spaces.partition(), file.path).readOnly) {
		menu.addItem((item) =>
			item.setTitle(LOCKED).setIcon("lock").setDisabled(true),
		);
	}
	if (status) {
		menu.addItem((item) =>
			item
				.setTitle(status.label)
				.setIcon(STATE_ICONS[status.state])
				.setDisabled(true),
		);
	}
	const edited = lastEditLabel(plugin, file.path);
	if (edited) {
		menu.addItem((item) =>
			item.setTitle(edited).setIcon("pencil").setDisabled(true),
		);
	}
	if ((status || edited) && here.length > 0) menu.addSeparator();
	for (const person of here) {
		const at = cursors.find(({ key }) => key === person.key)?.at ?? null;
		menu.addItem((item) => {
			item.setTitle(personTitle(person, at !== null));
			if (at === null) item.setDisabled(true);
			else item.onClick(() => jumpTo(plugin, leaf, view as MarkdownView, at));
		});
	}
	const { left, bottom } = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: left, y: bottom });
}

function personTitle(person: Person, hasCursor: boolean): DocumentFragment {
	const title = createFragment();
	renderAvatar(title, person);
	title.createSpan({ text: person.name });
	const state = hasCursor ? "go to cursor" : "no cursor here";
	title.createSpan({
		cls: "obsync-person-state",
		text: person.idle ? "away" : state,
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
