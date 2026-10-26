import { FakeStorage } from "@tests/helpers/fake-storage";
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONCURRENCY } from "@/constants";
import { deriveKey, type EncryptionKey, encryptJson } from "@/crypto";
import { type RecordKind, readRecords } from "@/storage/records";

interface Note {
	id: string;
}

const kind: RecordKind<Note> = {
	prefix: "notes/",
	label: "Note",
	parse: (value) => value as Note,
};

let key: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
});

/** Counts the reads in flight at once. */
class Slow extends FakeStorage {
	inFlight = 0;
	peak = 0;
	failOn: string | null = null;

	override async get(name: string): Promise<Uint8Array | null> {
		this.inFlight++;
		this.peak = Math.max(this.peak, this.inFlight);
		await new Promise((resolve) => setTimeout(resolve, 1));
		this.inFlight--;
		if (name === this.failOn) throw new Error("down");
		return super.get(name);
	}
}

async function seed(storage: FakeStorage, count: number): Promise<string[]> {
	const ids = Array.from(
		{ length: count },
		(_, i) => `n${String(i).padStart(2, "0")}`,
	);
	for (const id of ids) {
		await storage.put(`notes/${id}.json.enc`, await encryptJson(key, { id }));
	}
	return ids;
}

describe("readRecords", () => {
	it("reads a bounded number of records at once and keeps the listing order", async () => {
		const storage = new Slow();
		const ids = await seed(storage, 12);

		const { records } = await readRecords(storage, key, kind);

		expect(records.map((each) => each.id)).toEqual(ids);
		expect(storage.peak).toBe(DEFAULT_CONCURRENCY);
	});

	it("propagates a failed read", async () => {
		const storage = new Slow();
		await seed(storage, 6);
		storage.failOn = "notes/n03.json.enc";

		await expect(readRecords(storage, key, kind)).rejects.toThrow("down");
	});
});
