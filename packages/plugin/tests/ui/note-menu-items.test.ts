import { describe, expect, it } from "vitest";

import {
	type LiveState,
	type LiveStatus,
	STATE_ICONS,
} from "@/ui/live/live-status";
import {
	actionItems,
	infoItems,
	LOCKED,
	type MenuFacts,
	personState,
} from "@/ui/live/note-menu-items";

const NONE: MenuFacts = {
	locked: false,
	status: null,
	edited: null,
	relayDown: false,
	shared: false,
	liveText: false,
	authorsShown: false,
};

const titles = (items: { title: string }[]): string[] =>
	items.map(({ title }) => title);

describe("note header menu", () => {
	it("gives every state its own icon", () => {
		const icons = Object.values(STATE_ICONS);
		expect(new Set(icons).size).toBe(icons.length);
	});

	it("lists the lock, the state and the last edit, none of them actionable", () => {
		const status: LiveStatus = { state: "live", label: "Live" };
		const items = infoItems({
			...NONE,
			locked: true,
			status,
			edited: "Changed by Alex",
		});
		expect(items).toEqual([
			{ title: LOCKED, icon: "lock" },
			{ title: "Live", icon: STATE_ICONS.live },
			{ title: "Changed by Alex", icon: "pencil" },
		]);
		expect(items.some(({ action }) => action)).toBe(false);
	});

	it("shows the icon of the state it is in", () => {
		for (const state of Object.keys(STATE_ICONS) as LiveState[]) {
			const [item] = infoItems({ ...NONE, status: { state, label: state } });
			expect(item?.icon).toBe(STATE_ICONS[state]);
		}
	});

	it("offers nothing for a plain note of the vault", () => {
		expect(infoItems(NONE)).toEqual([]);
		expect(actionItems(NONE)).toEqual([]);
	});

	it("offers only a rebuild for a live note of the vault", () => {
		expect(titles(actionItems({ ...NONE, liveText: true }))).toEqual([
			"Rebuild live note",
		]);
	});

	it("offers a reader no rebuild: they never write the room", () => {
		const facts = { ...NONE, liveText: true, shared: true, locked: true };
		expect(titles(actionItems(facts))).toEqual([
			"Show who typed what",
			"Manage shared folder",
		]);
	});

	it("offers authors, the folder and a rebuild for a live note of a share", () => {
		const facts = { ...NONE, liveText: true, shared: true };
		expect(titles(actionItems(facts))).toEqual([
			"Show who typed what",
			"Manage shared folder",
			"Rebuild live note",
		]);
	});

	it("checks authors only while they are shown", () => {
		const facts = { ...NONE, liveText: true, shared: true };
		const authors = (authorsShown: boolean) =>
			actionItems({ ...facts, authorsShown }).find(
				({ action }) => action === "authors",
			);
		expect(authors(true)?.checked).toBe(true);
		expect(authors(false)?.checked).toBe(false);
	});

	it("offers the folder but neither authors nor a rebuild for a cold note or a drawing of a share", () => {
		expect(titles(actionItems({ ...NONE, shared: true }))).toEqual([
			"Manage shared folder",
		]);
	});

	it("offers a reconnect only while the relay is down", () => {
		expect(titles(actionItems({ ...NONE, relayDown: true }))).toEqual([
			"Reconnect",
		]);
		expect(titles(actionItems(NONE))).not.toContain("Reconnect");
	});

	it("words a person's cursor by what can be followed", () => {
		const here = { idle: false };
		expect(personState(here, true, true)).toBe("follow cursor");
		expect(personState({ idle: true }, true, true, true)).toBe("following");
		expect(personState(here, false, true)).toBe("no cursor here");
		expect(personState(here, false, false)).toBe("Cursor not shared");
		expect(personState({ idle: true }, false, false)).toBe("away");
	});
});
