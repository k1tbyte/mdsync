import { SHARE_ID, setup, spacesWith } from "@tests/helpers/presence-relay";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelPresence } from "@/presence/channel";
import type { People } from "@/presence/people";
import { type Space, VAULT_SPACE } from "@/sync/space";

const NOTE = "Team/a.md";

async function pair() {
	const { relay, accessFor, vaultKeys, shareKeys } = await setup();
	let ownerName = "Owner";
	const owner = relay.add(spacesWith("Team"), async (space) =>
		space.id === SHARE_ID
			? { keys: shareKeys, key: "owner", name: ownerName, device: "d1" }
			: { keys: vaultKeys, key: "d1", name: "d1", device: null },
	);
	const friend = relay.add(spacesWith("Team"), accessFor("d9", "p1", "Alex"));
	relay.join(owner);
	relay.join(friend);
	return {
		relay,
		owner,
		friend,
		rename: (name: string) => {
			ownerName = name;
			owner.people.refresh();
		},
	};
}

function watch(people: People, path: string): string[][] {
	const seen: string[][] = [];
	people.subscribe(() =>
		seen.push(people.inNote(path).map(({ name }) => name)),
	);
	return seen;
}

async function ownerInNote() {
	const it = await pair();
	const seen = watch(it.friend.people, NOTE);
	expect(it.friend.people.inNote(NOTE)).toEqual([]);
	it.owner.people.setHere({ path: NOTE, idle: false });
	await vi.waitFor(() => expect(seen.at(-1)).toEqual(["Owner"]));
	return { ...it, seen };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("people's derived views", () => {
	it("read each channel once however often they are asked", async () => {
		const { owner, friend } = await pair();
		owner.people.setHere({ path: NOTE, idle: false });
		await vi.waitFor(() => expect(friend.people.inNote(NOTE)).toHaveLength(1));
		await vi.waitFor(() =>
			expect(friend.people.online(VAULT_SPACE.id)).toHaveLength(1),
		);
		friend.spaces = [...friend.spaces];
		friend.people.refresh();
		const entries = vi.spyOn(ChannelPresence.prototype, "entries");

		const notes = friend.people.notes();
		const online = friend.people.online(SHARE_ID);
		for (let i = 0; i < 50; i++) {
			friend.people.inNote(NOTE);
			friend.people.online(SHARE_ID);
			friend.people.devices();
		}

		expect(friend.people.notes()).toBe(notes);
		expect(friend.people.online(SHARE_ID)).toBe(online);
		expect(entries).toHaveBeenCalledTimes(4);
	});

	it("drop what they read when disposed", async () => {
		const { friend } = await ownerInNote();
		expect(friend.people.inNote(NOTE)).toHaveLength(1);
		expect(friend.people.online(SHARE_ID)).toHaveLength(1);

		friend.people.dispose();

		expect(friend.people.inNote(NOTE)).toEqual([]);
		expect(friend.people.online(SHARE_ID)).toEqual([]);
	});

	it("follow an announcement changing", async () => {
		const { owner, friend, seen } = await ownerInNote();

		owner.people.setHere({ path: NOTE, idle: true });
		await vi.waitFor(() =>
			expect(friend.people.inNote(NOTE)[0]?.idle).toBe(true),
		);
		owner.people.setHere({ path: "Team/b.md", idle: true });

		await vi.waitFor(() => expect(seen.at(-1)).toEqual([]));
		expect(friend.people.inNote("Team/b.md")).toHaveLength(1);
	});

	it("follow a person leaving", async () => {
		const { relay, owner, friend, seen } = await ownerInNote();

		relay.leave(owner);

		await vi.waitFor(() => expect(seen.at(-1)).toEqual([]));
		expect(friend.people.online(SHARE_ID)).toEqual([]);
	});

	it("follow their own connection dropping", async () => {
		const { relay, friend, seen } = await ownerInNote();

		relay.leave(friend);

		expect(seen.at(-1)).toEqual([]);
		expect(friend.people.online(SHARE_ID)).toEqual([]);
	});

	it("follow a device renamed", async () => {
		const { rename, friend, seen } = await ownerInNote();
		expect(friend.people.online(SHARE_ID)[0]?.name).toBe("Owner");

		rename("Boss");

		await vi.waitFor(() => expect(seen.at(-1)).toEqual(["Boss"]));
		expect(friend.people.online(SHARE_ID)[0]?.name).toBe("Boss");
	});

	it("follow a folder moved, paused and closed", async () => {
		const { friend, seen } = await ownerInNote();
		const vault = friend.spaces[0] as Space;

		friend.spaces = [vault, { id: SHARE_ID, root: "Moved" }];
		friend.people.refresh();
		expect(seen.at(-1)).toEqual([]);
		expect(friend.people.inNote("Moved/a.md")).toHaveLength(1);

		friend.spaces = [vault, { id: SHARE_ID, root: "Moved", paused: true }];
		friend.people.refresh();
		expect(friend.people.inNote("Moved/a.md")).toEqual([]);
		expect(friend.people.online(SHARE_ID)).toEqual([]);

		friend.spaces = [vault];
		friend.people.refresh();
		expect(friend.people.online(SHARE_ID)).toEqual([]);
	});

	it("follow a folder mounted", async () => {
		const { owner, friend } = await pair();
		const [vault, share] = friend.spaces as [Space, Space];
		friend.spaces = [vault];
		friend.people.refresh();
		expect(friend.people.online(SHARE_ID)).toEqual([]);

		friend.spaces = [vault, share];
		friend.people.refresh();
		owner.people.setHere({ path: NOTE, idle: false });

		await vi.waitFor(() => expect(friend.people.inNote(NOTE)).toHaveLength(1));
		expect(friend.people.online(SHARE_ID)).toHaveLength(1);
	});

	it("repaint on a refresh only when the partition changed", async () => {
		const { friend } = await ownerInNote();
		const repainted = vi.fn();
		friend.people.subscribe(repainted);
		const notes = friend.people.notes();

		friend.people.refresh();

		expect(repainted).not.toHaveBeenCalled();
		expect(friend.people.notes()).toBe(notes);

		friend.spaces = [...friend.spaces];
		friend.people.refresh();

		expect(repainted).toHaveBeenCalledOnce();
		expect(friend.people.notes()).not.toBe(notes);
	});

	it("follow this device taking another key", async () => {
		const { relay, accessFor } = await setup();
		let key = "p1";
		const shared = accessFor("d9", "p2", "Sam");
		const friend = relay.add(spacesWith("Team"), async (space) => ({
			...(await shared(space)),
			key: space.id === SHARE_ID ? key : "d9",
		}));
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "p2", "Sam again"),
		);
		relay.join(owner);
		relay.join(friend);
		const seen = watch(friend.people, NOTE);
		owner.people.setHere({ path: NOTE, idle: false });
		await vi.waitFor(() => expect(seen.at(-1)).toEqual(["Sam again"]));

		key = "p2";
		friend.people.refresh();

		await vi.waitFor(() => expect(seen.at(-1)).toEqual([]));
		expect(friend.people.online(SHARE_ID)).toEqual([]);
	});
});
