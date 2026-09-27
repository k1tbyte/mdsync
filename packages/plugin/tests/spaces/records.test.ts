import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { mountError, spacesOf } from "@/spaces/partition";
import { isNewer, isSpaceRecord, type SpaceRecord } from "@/spaces/record";
import { SpaceRecords } from "@/spaces/records";
import { VAULT_SPACE } from "@/sync/space";

let key: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
});

function record(
	id: string,
	root: string,
	rev = 1,
	author = "laptop",
): SpaceRecord {
	return {
		id,
		name: id,
		root,
		rev,
		author,
		key: "",
		access: { kind: "owner", location: LOCATION },
	};
}

const LOCATION = {
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "vault",
	forcePathStyle: true,
};

/** One device's records, persisted into its own settings object. */
function device(spaces: SpaceRecord[] = []) {
	const settings = {
		spaces,
		pausedSpaces: [] as string[],
		localRoots: {} as Record<string, string>,
		spacesVault: null as string | null,
	};
	return { settings, records: new SpaceRecords(settings, async () => {}) };
}

describe("space records", () => {
	it("lets the higher revision win, then the larger author", () => {
		expect(isNewer(record("a", "x", 2), record("a", "x", 1))).toBe(true);
		expect(isNewer(record("a", "x", 1, "b"), record("a", "x", 1, "a"))).toBe(
			true,
		);
		expect(isNewer(record("a", "x", 1), record("a", "x", 1))).toBe(false);
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

		await laptop.records.setPaused("a", true);
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
		await laptop.records.setPaused("a", true);
		await laptop.records.setPaused("b", true);

		await laptop.records.setPaused("a", false);
		await laptop.records.close("b", "laptop");

		expect(laptop.settings.pausedSpaces).toEqual([]);
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

	it("stay with the vault storage they were traded with", async () => {
		const first = new FakeStorage("first");
		const laptop = device([record("a", "Shared/a")]);
		await laptop.records.setPaused("a", true);
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
