import { FakeStorage } from "@tests/helpers/fake-storage";
import { device, joined, record } from "@tests/helpers/space-records";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { mountError, spacesOf } from "@/spaces/partition";
import {
	closeRecord,
	isNewer,
	isSpaceRecord,
	mergeRecords,
	type SpaceRecord,
} from "@/spaces/record";
import type { SpaceRecords } from "@/spaces/records";
import { VAULT_SPACE } from "@/sync/space";

let key: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
});

describe("space records", () => {
	it("lets the higher revision win, then the larger author", () => {
		expect(isNewer(record("a", "x", 2), record("a", "x", 1))).toBe(true);
		expect(isNewer(record("a", "x", 1, "b"), record("a", "x", 1, "a"))).toBe(
			true,
		);
		expect(isNewer(record("a", "x", 1), record("a", "x", 1))).toBe(false);
	});

	it("keep a close over edits made offline before it, however many", () => {
		const open = record("a", "x", 1);
		const closed = closeRecord(open, "laptop");
		let moved = open;
		for (let i = 0; i < 50; i++)
			moved = { ...moved, root: `y${i}`, rev: moved.rev + 1 };

		expect(mergeRecords([closed], [moved])).toEqual([closed]);
	});

	it("rejects anything that is not a whole record", () => {
		expect(isSpaceRecord(record("a", "x"))).toBe(true);
		expect(isSpaceRecord({ ...record("a", "x"), rev: "1" })).toBe(false);
		const participant = {
			kind: "participant",
			relayUrl: "u",
			token: "t",
			participantId: "p1",
			personName: "Friend",
		};
		expect(isSpaceRecord({ ...record("a", "x"), access: participant })).toBe(
			true,
		);
		expect(
			isSpaceRecord({ ...record("a", "x"), access: { kind: "owner" } }),
		).toBe(false);
		expect(isSpaceRecord({ id: "a", root: "x" })).toBe(false);
	});
});

describe("the partition", () => {
	it("lists the vault first and every free root after it", () => {
		expect(spacesOf([record("b", "B"), record("a", "A")])).toEqual([
			VAULT_SPACE,
			{ id: "a", root: "A" },
			{ id: "b", root: "B" },
		]);
	});

	it("gives an overlapping folder to the smaller id", () => {
		const spaces = spacesOf([
			record("b", "Team"),
			record("a", "Team/docs"),
			record("c", "Team/docs"),
		]);
		expect(spaces.map((space) => space.id)).toEqual(["vault", "a"]);
	});

	it("names the open records left out, which only closing helps", async () => {
		const { records } = device([record("b", "Team"), record("a", "Team")]);
		expect(records.inert().map((each) => each.id)).toEqual(["b"]);

		await records.close("b", "laptop");
		expect(records.inert()).toEqual([]);
	});

	it("never mounts the vault root or a dot folder", () => {
		const spaces = spacesOf([record("a", ""), record("b", ".obsidian/x")]);
		expect(spaces).toEqual([VAULT_SPACE]);
	});

	it("tells why a folder cannot take a new space", () => {
		const spaces = spacesOf([record("a", "Team")]);
		expect(mountError("", spaces)).toMatch("vault");
		expect(mountError("notes/.hidden", spaces)).toMatch("Hidden");
		expect(mountError("Team/Docs", spaces)).toMatch("shared folder");
		expect(mountError("Team", spaces)).toMatch("shared folder");
		expect(mountError("Teams", spaces)).toBeNull();
	});
});

describe("read-only shares", () => {
	it("enter the partition marked, so nothing pushes into them by itself", () => {
		const reader: SpaceRecord = {
			...record("a", "Shared/a"),
			access: {
				kind: "participant",
				relayUrl: "r",
				token: "t",
				participantId: "p1",
				personName: "Friend",
				readOnly: true,
			},
		};

		expect(spacesOf([reader, record("b", "B")])).toEqual([
			VAULT_SPACE,
			{ id: "a", root: "Shared/a", readOnly: true },
			{ id: "b", root: "B" },
		]);
	});
});

describe("paused shares", () => {
	it("keep their root out of the vault, marked, on this device only", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();

		await laptop.records.setPause("a", "here", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		const paused = { id: "a", root: "Team", paused: true };
		expect(laptop.records.partition()).toEqual([VAULT_SPACE, paused]);
		expect(phone.records.partition()).toEqual([
			VAULT_SPACE,
			{ id: "a", root: "Team" },
		]);
	});

	it("resume where they left off, and a closed one is paused no more", async () => {
		const laptop = device([record("a", "Team"), record("b", "Notes")]);
		await laptop.records.setPause("a", "here", "laptop");
		await laptop.records.setPause("b", "here", "laptop");

		await laptop.records.setPause("a", null, "laptop");
		await laptop.records.close("b", "laptop");

		expect(laptop.settings.pausedSpaces).toEqual([]);
	});

	it("pause on every device of the person, and resume from any of them", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();
		await laptop.records.setPause("a", "everywhere", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		const paused = { id: "a", root: "Team", paused: true };
		expect(phone.records.partition()).toEqual([VAULT_SPACE, paused]);
		expect(phone.records.pauseOf("a")).toBe("everywhere");

		await phone.records.setPause("a", null, "phone");
		await phone.records.sync(storage, key);
		await laptop.records.sync(storage, key);

		expect(laptop.records.partition()).toEqual([
			VAULT_SPACE,
			{ id: "a", root: "Team" },
		]);
		expect(laptop.records.get("a")).toMatchObject({ rev: 3, author: "phone" });
	});

	it("switch between paused here and on every device in one step", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();
		await phone.records.sync(storage, key);
		await laptop.records.setPause("a", "here", "laptop");

		await laptop.records.setPause("a", "everywhere", "laptop");
		expect(laptop.settings.pausedSpaces).toEqual([]);
		expect(laptop.records.pauseOf("a")).toBe("everywhere");

		await laptop.records.setPause("a", "here", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		expect(laptop.records.pauseOf("a")).toBe("here");
		expect(phone.records.pauseOf("a")).toBeNull();
	});

	it("all pause where shared folders are off, those arriving later too", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();
		phone.settings.useSharedFolders = false;
		await laptop.records.sync(storage, key);
		await laptop.records.add(record("b", "Notes"));
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expect(phone.records.partition().slice(1)).toEqual([
			{ id: "a", root: "Team", paused: true },
			{ id: "b", root: "Notes", paused: true },
		]);
		expect(phone.records.pauseOf("a")).toBe("off");

		phone.settings.useSharedFolders = true;
		expect(phone.records.partition()).toHaveLength(3);
		expect(phone.records.partition().some((space) => space.paused)).toBe(false);
	});
});

describe("invites", () => {
	it("remember the relay they went through, as a new revision only when it changes", async () => {
		const laptop = device([record("a", "Team")]);

		await laptop.records.invitedVia("a", "https://relay.example", "phone");
		await laptop.records.invitedVia("a", "https://relay.example", "laptop");

		const [invited] = laptop.records.list();
		expect(invited?.access).toMatchObject({
			relayUrl: "https://relay.example",
		});
		expect([invited?.rev, invited?.author]).toEqual([2, "phone"]);
		expect(isSpaceRecord(invited)).toBe(true);
	});

	it("renew a share's access at its stored root, not where a move has not reached here", async () => {
		const phone = device([record("a", "Shared/New", 2)]);
		phone.settings.localRoots = { a: "Shared/Old" };
		const access = {
			kind: "participant",
			relayUrl: "https://other.example",
			token: "t",
			participantId: "p",
			personName: "Alex",
		} as const;

		await phone.records.renew("a", access, "phone");

		expect(phone.settings.spaces).toEqual([
			{ ...record("a", "Shared/New", 3, "phone"), access },
		]);
		expect(phone.records.list()[0]?.root).toBe("Shared/Old");
	});
});

describe("records through the vault storage", () => {
	it("reach another device of the same person", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Shared/a")]);
		const phone = device();

		// Only a trade that published something wakes the other devices.
		const published = async (records: SpaceRecords) =>
			(await records.sync(storage, key)).published;
		expect(await published(laptop.records)).toBe(true);
		expect(await published(phone.records)).toBe(false);
		expect(await published(laptop.records)).toBe(false);

		expect(phone.records.list()).toEqual([record("a", "Shared/a")]);
	});

	it("unpause a share another device closed", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Shared/a")]);
		const phone = device();
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		await phone.records.setPause("a", "here", "phone");

		await laptop.records.close("a", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expect(phone.settings.pausedSpaces).toEqual([]);
	});

	it("arrive paused on a device that asks so, only when new there", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Shared/a")]);
		const phone = device();
		phone.settings.pauseArrivingShares = true;
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		expect(phone.settings.pausedSpaces).toEqual(["a"]);

		await phone.records.setPause("a", null, "phone");
		await laptop.records.add(record("a", "Shared/a", 2));
		await laptop.records.add(record("b", "Shared/b"));
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expect(phone.settings.pausedSpaces).toEqual(["b"]);
		expect(phone.records.partition()).toContainEqual({
			id: "b",
			root: "Shared/b",
			paused: true,
		});
	});

	it("stay with the vault storage they were traded with", async () => {
		const first = new FakeStorage("first");
		const laptop = device([record("a", "Shared/a")]);
		await laptop.records.setPause("a", "here", "laptop");
		await laptop.records.sync(first, key);

		// Named, so this device forgets its state of it and says so.
		expect(
			(await laptop.records.sync(new FakeStorage("second"), key)).left,
		).toEqual([{ id: "a", root: "Shared/a" }]);
		expect([laptop.records.list(), laptop.settings.pausedSpaces]).toEqual([
			[],
			[],
		]);

		await laptop.records.sync(first, key);
		expect(laptop.records.list()).toEqual([record("a", "Shared/a")]);
	});

	it("tell a device which of its open shares another device closed", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Shared/a"), record("b", "Shared/b")]);
		const phone = device();
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		await laptop.records.close("a", "laptop");
		expect((await laptop.records.sync(storage, key)).closed).toEqual([]);

		expect((await phone.records.sync(storage, key)).closed).toEqual([
			{ id: "a", root: "Shared/a" },
		]);
		expect((await phone.records.sync(storage, key)).closed).toEqual([]);
	});

	it("keep a share joined before this device knew the vault over the vault's older close of it", async () => {
		const storage = new FakeStorage();
		const laptop = device([joined("a", "Shared/a")]);
		await laptop.records.sync(storage, key);
		await laptop.records.close("a", "laptop");
		await laptop.records.sync(storage, key);
		const closedRev = laptop.records.get("a")?.rev ?? 0;
		const guest = device([joined("a", "Mine/a", 1, "guest")]);

		expect((await guest.records.sync(storage, key)).closed).toEqual([]);
		await laptop.records.sync(storage, key);

		const rejoined = joined("a", "Mine/a", closedRev + 1, "guest");
		expect([guest.records.list(), laptop.records.list()]).toEqual([
			[rejoined],
			[rejoined],
		]);
	});

	it("keep the vault's own share its owner's over what a device joined or left before it knew the vault", async () => {
		const mine = joined("a", "Mine/a", 5, "zz");
		const cases = [
			{ guestOf: mine, moves: { a: "Mine/a" } },
			{ guestOf: { ...mine, closed: true as const }, moves: {} },
		];
		for (const { guestOf, moves } of cases) {
			const storage = new FakeStorage();
			const laptop = device([record("a", "Team")]);
			await laptop.records.sync(storage, key);
			const guest = device([guestOf]);

			await guest.records.sync(storage, key);
			await laptop.records.sync(storage, key);
			expect([
				guest.settings.spaces,
				guest.settings.localRoots,
				laptop.records.list(),
			]).toEqual([[record("a", "Team")], moves, [record("a", "Team")]]);
		}
	});

	it("admit a share joined before this device knew the vault only where the vault has nothing", async () => {
		const storage = new FakeStorage();
		await device([record("b", "Team")]).records.sync(storage, key);
		const admit = (root: string, paths: string[] = []) =>
			device([joined("a", root, 1, "guest")]).records.admitJoined(
				storage,
				key,
				async () => paths,
			);

		await expect(admit("Mine/a")).resolves.toBeUndefined();
		await expect(admit("Mine/a", ["Mine/a/x.md"])).rejects.toThrow(
			'Rename "Mine/a"',
		);
		await expect(admit("Team/a")).rejects.toThrow('Rename "Team/a"');
		// The vault holds another of this device's shares where it mounted this one.
		await device([joined("c", "Mine/c")]).records.sync(storage, key);
		const two = device([joined("c", "Other/c"), joined("d", "Mine/c")]);
		await expect(
			two.records.admitJoined(storage, key, async () => []),
		).rejects.toThrow('Rename "Mine/c"');

		// Bound: its records were traded with this vault already.
		const bound = device([joined("a", "Team/a", 1, "guest")]);
		bound.settings.spacesVault = storage.identity();
		await expect(
			bound.records.admitJoined(storage, key, async () => []),
		).resolves.toBeUndefined();
	});

	it("keep the later edit of one record from two devices", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Old", 1)]);
		await laptop.records.sync(storage, key);
		const phone = device([record("a", "New", 2, "phone")]);

		await phone.records.sync(storage, key);
		await laptop.records.sync(storage, key);

		expect(laptop.settings.spaces).toEqual([record("a", "New", 2, "phone")]);
	});

	it("keep a record added while a trade is in flight", async () => {
		const storage = new FakeStorage();
		const laptop = device();

		const trading = laptop.records.sync(storage, key);
		await laptop.records.add(record("a", "Shared/a"));
		await trading;
		await laptop.records.sync(storage, key);

		expect(laptop.records.list()).toEqual([record("a", "Shared/a")]);
		expect(storage.map.has("spaces/a.json.enc")).toBe(true);
	});

	it("close on every device of the person, and the folder leaves the partition", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		await laptop.records.close("a", "laptop");
		expect((await laptop.records.sync(storage, key)).published).toBe(true);
		await phone.records.sync(storage, key);

		expect(phone.records.list()).toMatchObject([{ id: "a", closed: true }]);
		expect(spacesOf(phone.records.list())).toEqual([VAULT_SPACE]);
		// Closed, the root is free for a share of its own again.
		expect(mountError("Team", spacesOf(phone.records.list()))).toBeNull();
	});

	it("skip a record that is unreadable or filed under another id", async () => {
		const storage = new FakeStorage();
		storage.map.set("spaces/a.json.enc", Uint8Array.of(1, 2, 3));
		storage.map.set(
			"spaces/b.json.enc",
			await encryptJson(key, record("c", "Stolen")),
		);
		const phone = device();

		await phone.records.sync(storage, key);

		expect(phone.records.list()).toEqual([]);
	});
});

describe("a moved shared folder", () => {
	async function pair() {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Team")]);
		const phone = device();
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		return { storage, laptop, phone };
	}

	it("stays where it is on the other devices until it moves there", async () => {
		const { storage, laptop, phone } = await pair();

		await laptop.records.moveRoot("a", "Projects/Team", "laptop");
		expect((await laptop.records.sync(storage, key)).published).toBe(true);
		await phone.records.sync(storage, key);

		expect(phone.records.moves()).toEqual([
			{ id: "a", from: "Team", to: "Projects/Team" },
		]);
		expect(phone.records.partition()).toEqual([
			VAULT_SPACE,
			{ id: "a", root: "Team" },
		]);

		await phone.records.moveRoot("a", "Projects/Team", "phone");
		expect(phone.records.moves()).toEqual([]);
		// Settled, not edited: nothing new to publish.
		expect(phone.records.list()).toEqual([
			record("a", "Projects/Team", 2, "laptop"),
		]);
	});

	it("needs no move once it is back where it was", async () => {
		const { storage, laptop, phone } = await pair();
		await laptop.records.moveRoot("a", "Projects/Team", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		await laptop.records.moveRoot("a", "Team", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expect(phone.records.moves()).toEqual([]);
		expect(phone.records.partition()).toMatchObject([{}, { root: "Team" }]);
	});

	it("is not moved where it was closed: that folder is the vault's", async () => {
		const { storage, laptop, phone } = await pair();
		await phone.records.close("a", "phone");
		await phone.records.sync(storage, key);
		await laptop.records.sync(storage, key);

		// Accepted again elsewhere, at another folder.
		await laptop.records.add(record("a", "Shared/Team", 3));
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expect(phone.records.moves()).toEqual([]);
	});

	it("is left where it is once the share closes, here or elsewhere", async () => {
		const { storage, laptop, phone } = await pair();
		await laptop.records.moveRoot("a", "Projects/Team", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		await laptop.records.close("a", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		expect(phone.records.moves()).toEqual([]);

		const tablet = device([record("a", "Team")]);
		tablet.settings.localRoots = { a: "Old" };
		await tablet.records.close("a", "tablet");
		expect(tablet.records.moves()).toEqual([]);
	});
});
