import { OWNER } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";
import { RELAY_TEXT, UNREADABLE_TEXT } from "@/core/hub/relay-text";
import type { RelayStatus } from "@/core/hub/status";
import type { Person } from "@/features/presence/people";
import type { Participant } from "@/features/spaces/broker/share-broker";
import type { SpaceRecord } from "@/features/spaces/record";
import {
	presenceNote,
	selfRow,
	shareRows,
} from "@/features/spaces/ui/window/share-people";

const person = (
	key: string,
	name: string,
	rest: Partial<Person> = {},
): Person => ({
	key,
	name,
	devices: [],
	note: null,
	idle: false,
	...rest,
});
const participant = (
	id: string,
	label: string,
	readOnly = false,
): Participant => ({
	id,
	label,
	readOnly,
});

describe("shareRows with the owner's list", () => {
	it("joins who holds access with where they are now", () => {
		const rows = shareRows(
			[person("a", "Alex", { note: "Team/docs/plan.md" })],
			[participant("a", "Alex"), participant("b", "Sam", true)],
			OWNER,
		);

		expect(rows.map(({ name, role, detail }) => [name, role, detail])).toEqual([
			["Alex", "Can edit", "In plan.md"],
			["Sam", "Read-only", "Not here now"],
		]);
	});

	it("puts the ones here first, then by name", () => {
		const rows = shareRows(
			[person("c", "Zed")],
			[
				participant("a", "Alex"),
				participant("c", "Zed"),
				participant("b", "Bea"),
			],
			OWNER,
		);

		expect(rows.map(({ name }) => name)).toEqual(["Zed", "Alex", "Bea"]);
	});

	it("says away, or online with no note open", () => {
		const rows = shareRows(
			[person("a", "Alex", { idle: true }), person("b", "Bea")],
			[participant("a", "Alex"), participant("b", "Bea")],
			OWNER,
		);

		expect(rows.map(({ detail }) => detail)).toEqual(["Away", "Online"]);
	});

	it("keeps a revocable participant on every row and names the unnamed", () => {
		const [row] = shareRows([], [participant("a", "")], OWNER);

		expect(row).toMatchObject({
			name: "Unnamed",
			person: null,
			participant: { id: "a" },
		});
	});

	it("does not list someone here who holds no access", () => {
		expect(shareRows([person("gone", "Ghost")], [], OWNER)).toEqual([]);
	});
});

describe("shareRows without the owner's list", () => {
	it("lists whoever is here, the owner named as such, nothing to revoke", () => {
		const rows = shareRows(
			[person("b", "Sam", { note: "n.md" }), person(OWNER, "Owner")],
			null,
			"me",
		);

		expect(rows.map(({ name, role, detail }) => [name, role, detail])).toEqual([
			["Owner", "Owner", "Online"],
			["Sam", null, "In n.md"],
		]);
		expect(rows.every(({ participant }) => participant === null)).toBe(true);
	});

	it("is empty when nobody is here", () => {
		expect(shareRows([], null, "me")).toEqual([]);
	});

	it("leaves this person's other devices to their own row", () => {
		const rows = shareRows(
			[person("me", "Kit"), person("b", "Sam")],
			null,
			"me",
		);

		expect(rows.map(({ name }) => name)).toEqual(["Sam"]);
	});
});

describe("presenceNote", () => {
	it.each<RelayStatus>([
		"off",
		"no-relay",
		"paused",
		"connecting",
		"unauthorized",
		"offline",
	])("says what the relay is doing while it is %s", (status) => {
		expect(presenceNote(status, false)).toBe(`${RELAY_TEXT[status]}.`);
	});

	it("says others cannot be read, once connected", () => {
		expect(presenceNote("connected", true)).toBe(`${UNREADABLE_TEXT}.`);
	});

	it("has nothing to add when all is well", () => {
		expect(presenceNote("connected", false)).toBeNull();
	});
});

describe("shareRows as a redraw signature", () => {
	const signature = (here: Person[]) =>
		JSON.stringify(shareRows(here, [participant("a", "Alex")], OWNER));

	it("is equal for equal people and differs once someone moves", () => {
		const alex = person("a", "Alex", { note: "Team/a.md" });

		expect(signature([{ ...alex }])).toBe(signature([{ ...alex }]));
		expect(signature([{ ...alex, note: "Team/b.md" }])).not.toBe(
			signature([alex]),
		);
		expect(signature([{ ...alex, idle: true }])).not.toBe(signature([alex]));
	});
});

describe("selfRow", () => {
	const record = (access: object) => ({ access }) as SpaceRecord;

	it("is the owner, at the open note of the share", () => {
		const row = selfRow(record({ kind: "owner", name: "Kit" }), "Team/plan.md");

		expect([row.key, row.name, row.role, row.detail]).toEqual([
			OWNER,
			"Kit",
			"Owner",
			"In plan.md",
		]);
	});

	it("is a participant with their access, online elsewhere", () => {
		const row = selfRow(
			record({
				kind: "participant",
				participantId: "p1",
				personName: "Sam",
				readOnly: true,
			}),
			null,
		);

		expect([row.key, row.name, row.role, row.detail]).toEqual([
			"p1",
			"Sam",
			"Read-only",
			"Online",
		]);
	});
});
