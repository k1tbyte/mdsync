import { FakeStorage } from "@tests/helpers/fake-storage";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { beforeAll, describe, expect, it } from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptBytes,
	sha256Hex,
} from "@/crypto";
import { HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import { textToBytes } from "@/sync/content";
import { buildHistoryDiff, type HistoryDiffRequest } from "@/sync/projection";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

async function storeText(
	storage: FakeStorage,
	k: EncryptionKey,
	text: string,
): Promise<string> {
	const bytes = textToBytes(text);
	const hash = await sha256Hex(bytes);
	const encrypted = await encryptBytes(k, bytes);
	storage.map.set(`objects/${hash}`, encrypted);
	return hash;
}

class TrackingStorage extends FakeStorage {
	gets: string[] = [];
	override get(k: string): Promise<Uint8Array | null> {
		this.gets.push(k);
		return super.get(k);
	}
}

describe("buildHistoryDiff with absent sides", () => {
	it("reports missing stored content instead of presenting an empty file", async () => {
		await expect(
			buildHistoryDiff(
				{
					adapter: new InMemoryAdapter().asDataAdapter(),
					storage: new FakeStorage(),
					key,
				},
				{
					path: "gone.md",
					left: {
						version: { hash: "missing", label: "Old version", size: 12 },
					},
					right: { absent: true, label: "Deleted" },
				},
			),
		).rejects.toThrow("This version is no longer available");
	});
	it("absent side is not present and has empty text", async () => {
		const storage = new TrackingStorage();
		const h1 = await storeText(storage, key, "hello\n");
		const adapter = new InMemoryAdapter();
		const request: HistoryDiffRequest = {
			path: "note.md",
			left: { version: { hash: h1, label: "V1", size: 6 } },
			right: { absent: true, label: "(deleted)" },
		};
		const model = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			request,
		);
		expect(model.leftPresent).toBe(true);
		expect(model.leftText).toBe("hello\n");
		expect(model.rightPresent).toBe(false);
		expect(model.rightText).toBe("");
		expect(model.rightLabel).toBe("(deleted)");
	});

	it("absent left is different from empty file version", async () => {
		const storage = new TrackingStorage();
		const emptyHash = await storeText(storage, key, "");
		const contentHash = await storeText(storage, key, "content\n");
		const adapter = new InMemoryAdapter();

		// Absent left
		const absentReq: HistoryDiffRequest = {
			path: "note.md",
			left: { absent: true, label: "(did not exist)" },
			right: { version: { hash: contentHash, label: "V2", size: 8 } },
		};
		const absentModel = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			absentReq,
		);
		expect(absentModel.leftPresent).toBe(false);

		// Empty version left
		const emptyReq: HistoryDiffRequest = {
			path: "note.md",
			left: { version: { hash: emptyHash, label: "Empty", size: 0 } },
			right: { version: { hash: contentHash, label: "V2", size: 8 } },
		};
		const emptyModel = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			emptyReq,
		);
		expect(emptyModel.leftPresent).toBe(true);
		expect(emptyModel.leftText).toBe("");
	});

	it("does not download content for binary extension with absent other side", async () => {
		const storage = new TrackingStorage();
		const adapter = new InMemoryAdapter();
		const request: HistoryDiffRequest = {
			path: "photo.jpg",
			left: { version: { hash: "imgH", label: "V1", size: 50000 } },
			right: { absent: true, label: "(deleted)" },
		};
		const model = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			request,
		);
		expect(model.isBinary).toBe(true);
		// Known binary extension means no content was downloaded
		expect(storage.gets).toEqual([]);
	});

	it("does not download oversized version sides", async () => {
		const storage = new TrackingStorage();
		const adapter = new InMemoryAdapter();
		const size = HUNK_TEXT_MAX_BYTES + 100;
		const request: HistoryDiffRequest = {
			path: "big.md",
			left: { version: { hash: "bigH", label: "V1", size } },
			right: { absent: true, label: "(deleted)" },
		};
		const model = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			request,
		);
		expect(model.isBinary).toBe(true);
		expect(model.leftSize).toBe(size);
		expect(storage.gets).toEqual([]);
	});

	it("both sides absent produces empty non-binary model", async () => {
		const storage = new TrackingStorage();
		const adapter = new InMemoryAdapter();
		const request: HistoryDiffRequest = {
			path: "gone.md",
			left: { absent: true, label: "(before)" },
			right: { absent: true, label: "(after)" },
		};
		const model = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			request,
		);
		expect(model.leftPresent).toBe(false);
		expect(model.rightPresent).toBe(false);
		expect(model.isBinary).toBe(false);
		expect(model.hunks.hunks).toHaveLength(0);
		expect(storage.gets).toEqual([]);
	});

	it("empty file appears as present with empty text", async () => {
		const storage = new TrackingStorage();
		const emptyHash = await storeText(storage, key, "");
		const adapter = new InMemoryAdapter();
		const request: HistoryDiffRequest = {
			path: "empty.md",
			left: { version: { hash: emptyHash, label: "V1", size: 0 } },
			right: { absent: true, label: "(deleted)" },
		};
		const model = await buildHistoryDiff(
			{ adapter: adapter.asDataAdapter(), storage, key },
			request,
		);
		expect(model.leftPresent).toBe(true);
		expect(model.leftText).toBe("");
		expect(model.rightPresent).toBe(false);
	});
});
