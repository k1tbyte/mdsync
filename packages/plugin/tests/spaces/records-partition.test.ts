import { FakeStorage } from "@tests/helpers/fake-storage";
import { device, record } from "@tests/helpers/space-records";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { deriveKey, type EncryptionKey } from "@/crypto";
import { spacesOf } from "@/spaces/partition";
import { SpaceRecords } from "@/spaces/records";

vi.mock("@/spaces/partition", async (original) => {
	const actual = await original<typeof import("@/spaces/partition")>();
	return { ...actual, spacesOf: vi.fn(actual.spacesOf) };
});

let key: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
});

type Device = ReturnType<typeof device>;

function expectFresh({ records, settings }: Device): void {
	const oracle = new SpaceRecords(settings, async () => {});
	expect(records.partition()).toEqual(oracle.partition());
	expect(records.list()).toEqual(oracle.list());
}

describe("the memoized partition", () => {
	it("is derived once however often it is asked", () => {
		const { records } = device([record("a", "A"), record("b", "B")]);
		vi.mocked(spacesOf).mockClear();

		const first = records.partition();
		for (let i = 0; i < 50; i++) {
			records.partition();
			records.inert();
			records.list();
		}

		expect(spacesOf).toHaveBeenCalledTimes(1);
		expect(records.partition()).toBe(first);
		expect(records.list()).toBe(records.list());
	});

	it("is never stale after adding, closing, moving or pausing", async () => {
		const laptop = device([record("a", "A")]);
		const steps = [
			() => laptop.records.add(record("b", "B")),
			() => laptop.records.setPaused("b", true),
			() => laptop.records.setPaused("b", false),
			() => laptop.records.moveRoot("b", "Moved", "laptop"),
			() => laptop.records.settle("b"),
			() => laptop.records.close("a", "laptop"),
		];

		for (const step of steps) {
			laptop.records.partition();
			await step();
			expectFresh(laptop);
		}

		expect(laptop.records.partition().map(({ root }) => root)).toEqual([
			"",
			"Moved",
		]);
	});

	it("follows the roots a move leaves in place here", async () => {
		const storage = new FakeStorage();
		const laptop = device([record("a", "Old")]);
		const phone = device();
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);
		phone.records.partition();

		await laptop.records.moveRoot("a", "New", "laptop");
		await laptop.records.sync(storage, key);
		await phone.records.sync(storage, key);

		expectFresh(phone);
		expect(phone.settings.localRoots).toEqual({ a: "Old" });
		expect(phone.records.partition().at(1)?.root).toBe("Old");

		await phone.records.settle("a");
		expectFresh(phone);
		expect(phone.records.partition().at(1)?.root).toBe("New");
	});

	it("is never stale after a sync brings, drops or rebinds records", async () => {
		const storage = new FakeStorage("first");
		const laptop = device([record("a", "A")]);
		const phone = device();
		await laptop.records.sync(storage, key);

		phone.records.partition();
		await phone.records.sync(storage, key);
		expectFresh(phone);
		expect(phone.records.partition()).toHaveLength(2);

		await laptop.records.close("a", "laptop");
		await laptop.records.sync(storage, key);
		phone.records.partition();
		await phone.records.sync(storage, key);
		expectFresh(phone);
		expect(phone.records.partition()).toHaveLength(1);

		await laptop.records.add(record("b", "B"));
		await laptop.records.setPaused("b", true);
		laptop.records.partition();
		await laptop.records.sync(new FakeStorage("second"), key);
		expectFresh(laptop);
	});

	it("is never stale after the settings are replaced wholesale", () => {
		const laptop = device([record("a", "A")]);
		laptop.records.partition();

		Object.assign(laptop.settings, {
			spaces: [record("b", "B"), record("c", "C")],
			pausedSpaces: ["c"],
			localRoots: { b: "Elsewhere" },
		});

		expectFresh(laptop);
		expect(laptop.records.partition()).toEqual([
			{ id: "vault", root: "" },
			{ id: "b", root: "Elsewhere" },
			{ id: "c", root: "C", paused: true },
		]);
	});
});
