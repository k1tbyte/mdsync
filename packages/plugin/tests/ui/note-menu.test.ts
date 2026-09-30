import { FakeMenu, fragment, titleOf } from "@tests/helpers/fake-menu";
import { FileView, type Plugin, type WorkspaceLeaf } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { CursorFollow } from "@/ui/live/cursor-follow";
import type { LiveStatus } from "@/ui/live/live-status";
import {
	openActiveNoteMenu,
	openNoteMenu,
	registerNoteMenuCommand,
} from "@/ui/live/note-menu";
import { LOCKED } from "@/ui/live/note-menu-items";
import { openShareWindow } from "@/ui/shares/share-window";

const status: { current: LiveStatus | null } = { current: null };

vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	Menu: (await import("@tests/helpers/fake-menu")).FakeMenu,
}));
vi.mock("@/ui/live/live-status", async (original) => ({
	...(await original<object>()),
	liveStatusOf: () => status.current,
}));
vi.mock("@/ui/shares/share-window", () => ({
	shareAt: (_plugin: unknown, root: string) =>
		root === "Team" ? { id: "s1", root } : undefined,
	openShareWindow: vi.fn(),
}));

const ALEX: Person = {
	key: "p1",
	name: "Alex",
	note: "Team/a.md",
	idle: false,
};
const SAM: Person = { key: "p2", name: "Sam", note: "Team/a.md", idle: true };

const containerEl = {
	getBoundingClientRect: () => ({
		left: 100,
		top: 30,
		width: 400,
		height: 300,
	}),
	doc: "the-popout",
};

const noteView = (path: string, navigation = true) =>
	Object.assign(Object.create(FileView.prototype), {
		file: { path },
		navigation,
		containerEl,
	});
const leafOf = (view: unknown) => ({ view }) as unknown as WorkspaceLeaf;

function setup(
	options: { leaf?: unknown; here?: Person[]; readOnly?: boolean } = {},
) {
	const { leaf = leafOf(noteView("Team/a.md")), here = [], readOnly } = options;
	const plugin = {
		app: { workspace: { getMostRecentLeaf: () => leaf } },
		settings: { showLiveAuthors: false },
		controller: { lastEdit: () => undefined },
		spaces: {
			partition: () => [
				{ id: "vault", root: "" },
				{ id: "s1", root: "Team", ...(readOnly ? { readOnly: true } : {}) },
			],
		},
		realtime: {
			statusOf: () => "connected",
			people: { inNote: () => here },
			live: { roomOf: () => null },
			hub: { reconnect: vi.fn() },
		},
	} as unknown as PluginHost;
	return { plugin, leaf: leaf as WorkspaceLeaf, follows: new CursorFollow() };
}

const lastMenu = (): FakeMenu => FakeMenu.shown.at(-1) as FakeMenu;
const titles = (menu: FakeMenu) => menu.items.map(titleOf);

beforeEach(() => {
	FakeMenu.shown = [];
	status.current = { state: "cold", label: "Waiting for the key" };
	vi.stubGlobal("createFragment", fragment);
	vi.mocked(openShareWindow).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("a note's live menu", () => {
	it("lists the state, then who is here, then what can be done in a shared folder", () => {
		const { plugin, leaf, follows } = setup({ here: [ALEX, SAM] });

		openNoteMenu(plugin, leaf, follows);

		expect(titles(lastMenu())).toEqual([
			["Waiting for the key"],
			["A", "Alex", "Cursor not shared"],
			["S", "Sam", "away"],
			["Manage shared folder"],
		]);
		expect(lastMenu().separators).toBe(2);
	});

	it("shows the state and the lock as rows a keyboard can reach, not as disabled ones", () => {
		const { plugin, leaf, follows } = setup({ readOnly: true });

		openNoteMenu(plugin, leaf, follows);

		const [locked, state] = lastMenu().items;
		expect([locked?.label, locked?.disabled, titleOf(locked as never)]).toEqual(
			[true, false, [LOCKED]],
		);
		expect([state?.label, state?.disabled]).toEqual([true, false]);
	});

	it("opens the share window from its action", () => {
		const { plugin, leaf, follows } = setup();
		openNoteMenu(plugin, leaf, follows);

		lastMenu()
			.items.find(({ title }) => title === "Manage shared folder")
			?.click?.();

		expect(openShareWindow).toHaveBeenCalledWith(plugin, {
			id: "s1",
			root: "Team",
		});
	});

	it("reads the header again each time it opens", () => {
		const { plugin, leaf, follows } = setup();
		openNoteMenu(plugin, leaf, follows);

		status.current = { state: "live", label: "Live now" };
		openNoteMenu(plugin, leaf, follows);

		expect(titles(FakeMenu.shown[0] as FakeMenu)[0]).toEqual([
			"Waiting for the key",
		]);
		expect(titles(lastMenu())[0]).toEqual(["Live now"]);
	});

	it("opens under the chip it was opened from", () => {
		const { plugin, leaf, follows } = setup();
		const chip = {
			isShown: () => true,
			getBoundingClientRect: () => ({ left: 40, top: 50, bottom: 70 }),
			win: { innerHeight: 600 },
			doc: "the-document",
		} as unknown as HTMLElement;

		openNoteMenu(plugin, leaf, follows, chip);

		expect(lastMenu().at).toEqual({
			position: { x: 40, y: 70 },
			doc: "the-document",
		});
	});

	it("opens nothing for a pane that is no note tab", () => {
		const { plugin, follows } = setup();

		openNoteMenu(plugin, leafOf(noteView("Team/a.md", false)), follows);

		expect(FakeMenu.shown).toEqual([]);
	});
});

describe("the command that opens the note's menu", () => {
	it("is registered under its own id, only available while the header has something to show", () => {
		const commands: {
			id: string;
			name: string;
			checkCallback: (c: boolean) => boolean;
		}[] = [];
		const { plugin, follows } = setup();
		registerNoteMenuCommand(
			{
				...plugin,
				addCommand: (command: never) => commands.push(command),
			} as unknown as Plugin & PluginHost,
			follows,
		);

		expect(commands.map(({ id, name }) => [id, name])).toEqual([
			["show-note-live-menu", "Show live menu of this note"],
		]);
		expect(commands[0]?.checkCallback(true)).toBe(true);
		expect(FakeMenu.shown).toEqual([]);
		commands[0]?.checkCallback(false);
		expect(FakeMenu.shown).toHaveLength(1);
	});

	it("opens in the middle of the note's own view when run from the palette, in its window", () => {
		const { plugin, follows } = setup();

		expect(openActiveNoteMenu(plugin, follows, false)).toBe(true);

		expect(lastMenu().at).toEqual({
			position: { x: 300, y: 130 },
			doc: "the-popout",
		});
	});

	it("is unavailable for a note the header has nothing on, or without a note tab", () => {
		status.current = null;
		const bare = setup();
		const none = setup({ leaf: null });

		expect(openActiveNoteMenu(bare.plugin, bare.follows, true)).toBe(false);
		expect(openActiveNoteMenu(none.plugin, none.follows, false)).toBe(false);
		expect(FakeMenu.shown).toEqual([]);
	});
});
