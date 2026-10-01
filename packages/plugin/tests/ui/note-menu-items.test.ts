import { describe, expect, it } from "vitest";

import type { LiveStatus } from "@/ui/live/header/live-status";
import {
	actionItems,
	canRebuild,
	infoItems,
	LOCKED,
	type MenuFacts,
	type PersonView,
	personState,
} from "@/ui/live/header/note-menu-items";
import { type LiveState, STATE_ICONS } from "@/ui/live/live-state";

const NONE: MenuFacts = {
	locked: false,
	status: null,
	edited: null,
	relayFix: null,
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
			"Manage sharing",
		]);
	});

	it("offers authors, the folder and a rebuild for a live note of a share", () => {
		const facts = { ...NONE, liveText: true, shared: true };
		expect(titles(actionItems(facts))).toEqual([
			"Show who typed what",
			"Manage sharing",
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
			"Manage sharing",
		]);
	});

	it("offers a reconnect for an unreachable relay, its settings for a refusing one", () => {
		const offer = (relayFix: MenuFacts["relayFix"]) =>
			titles(actionItems({ ...NONE, relayFix }));

		expect(offer("reconnect")).toEqual(["Reconnect"]);
		expect(offer("settings")).toEqual(["Open relay settings"]);
		expect(offer(null)).toEqual([]);
	});

	it("lets one predicate decide the rebuild for the menu and the command", () => {
		const rebuild = (liveText: boolean, locked: boolean) =>
			canRebuild({ liveText, locked });

		expect(rebuild(true, false)).toBe(true);
		expect(rebuild(true, true)).toBe(false);
		expect(rebuild(false, false)).toBe(false);
		const facts = { ...NONE, liveText: true, locked: true };
		expect(actionItems(facts).some(({ action }) => action === "rebuild")).toBe(
			canRebuild(facts),
		);
	});
});

describe("a person in the note menu", () => {
	const view = (patch: Partial<PersonView>): PersonView => ({
		idle: false,
		following: false,
		...patch,
	});

	it("offers to follow anyone in the note, and marks them away", () => {
		expect(personState(view({}))).toBe("follow");
		expect(personState(view({ idle: true }))).toBe("follow (away)");
	});

	it("says following while following, even when they went away", () => {
		expect(personState(view({ following: true, idle: true }))).toBe(
			"following",
		);
	});
});
