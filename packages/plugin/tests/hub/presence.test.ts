import { EFrame, type ServerFrame } from "@obsync/protocol";
import { describe, expect, it } from "vitest";

import { ChannelPresence } from "@/hub/presence";

const SELF = { id: "self", name: "Laptop" };

function peer(from: number, announcement: unknown): ServerFrame {
	const text =
		typeof announcement === "string"
			? announcement
			: JSON.stringify(announcement);
	return {
		type: EFrame.Peer,
		slot: 0,
		doc: "",
		from,
		payload: new TextEncoder().encode(text),
	};
}

function leave(from: number): ServerFrame {
	return { type: EFrame.Leave, slot: 0, doc: "", from };
}

describe("ChannelPresence", () => {
	it("lists other devices by name, one entry per device", () => {
		const presence = new ChannelPresence(SELF);
		presence.apply(peer(1, { id: "b", name: "Phone" }));
		presence.apply(peer(2, { id: "a", name: "Desktop" }));
		presence.apply(peer(3, { id: "b", name: "Phone" }));
		presence.apply(peer(4, SELF));

		expect(presence.devices()).toEqual([
			{ id: "a", name: "Desktop" },
			{ id: "b", name: "Phone" },
		]);
	});

	it("keeps a device while any of its sockets remains", () => {
		const presence = new ChannelPresence(SELF);
		presence.apply(peer(1, { id: "b", name: "Phone" }));
		presence.apply(peer(2, { id: "b", name: "Phone" }));

		expect(presence.apply(leave(1))).toBe(true);
		expect(presence.devices()).toHaveLength(1);
		presence.apply(leave(2));
		expect(presence.devices()).toEqual([]);
		expect(presence.apply(leave(2))).toBe(false);
	});

	it("replaces a socket's announcement when it re-announces", () => {
		const presence = new ChannelPresence(SELF);
		presence.apply(peer(1, { id: "b", name: "Phone" }));
		presence.apply(peer(1, { id: "b", name: "Renamed" }));

		expect(presence.devices()).toEqual([{ id: "b", name: "Renamed" }]);
	});

	it.each([
		["not json", "{"],
		["not an object", 7],
		["missing name", { id: "b" }],
		["blank id", { id: "  ", name: "Phone" }],
		["non-string name", { id: "b", name: 1 }],
	])("ignores a malformed announcement: %s", (_, announcement) => {
		const presence = new ChannelPresence(SELF);

		expect(presence.apply(peer(1, announcement))).toBe(false);
		expect(presence.devices()).toEqual([]);
	});

	it("trims and caps announced fields", () => {
		const presence = new ChannelPresence(SELF);
		presence.apply(peer(1, { id: ` ${"i".repeat(100)} `, name: "  Tablet  " }));

		expect(presence.devices()).toEqual([
			{ id: "i".repeat(64), name: "Tablet" },
		]);
	});

	it("announces itself and forgets everyone on clear", () => {
		const presence = new ChannelPresence(SELF);
		presence.apply(peer(1, { id: "b", name: "Phone" }));
		presence.clear();

		expect(presence.devices()).toEqual([]);
		expect(
			JSON.parse(new TextDecoder().decode(presence.announcement())),
		).toEqual(SELF);
	});

	it("ignores frames that are not presence", () => {
		const presence = new ChannelPresence(SELF);

		expect(
			presence.apply({ type: EFrame.Signal, slot: 0, doc: "", from: 1 }),
		).toBe(false);
	});
});
