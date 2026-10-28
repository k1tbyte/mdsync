import { FakeStorage } from "@tests/helpers/fake-storage";
import { manifestOf } from "@tests/helpers/history";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { publishManifestWithHistory } from "@/features/sync/history/publish";
import { pushKey, readHistory } from "@/features/sync/history/remote";
import { objectKey } from "@/features/sync/remote/manifest";
import { resetRemoteStorage } from "@/features/sync/remote/reset";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

const history = { horizon: null };

const s1 = manifestOf("s1", null, { "a.md": "A1" });
const s2 = manifestOf("s2", "s1", { "a.md": "A2" });

/** A push uploads its blobs before any record names them. */
async function stored(): Promise<FakeStorage> {
	const storage = new FakeStorage();
	for (const hash of ["A1", "A2", "L", "X"]) {
		await storage.put(objectKey(hash), new Uint8Array([1]));
	}
	return storage;
}

function failPutOnce(storage: FakeStorage, failing: string): void {
	const put = storage.put.bind(storage);
	vi.spyOn(storage, "put").mockImplementation((objectKey, body) =>
		objectKey === failing
			? Promise.reject(new Error("offline"))
			: put(objectKey, body),
	);
}

describe("publishManifestWithHistory", () => {
	it("writes the push record, with the diff from its parent, before the manifest", async () => {
		const storage = await stored();
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		const put = vi.spyOn(storage, "put");

		await publishManifestWithHistory(storage, key, "", s2, s1, history);

		expect(put.mock.calls.map(([objectKey]) => objectKey)).toEqual([
			pushKey("s2"),
			REMOTE_MANIFEST_KEY,
		]);
		const { view } = await readHistory(storage, key, "");
		expect(view.pushes.get(pushKey("s2"))?.push.changes.modified).toEqual({
			"a.md": { from: s1.files["a.md"], to: s2.files["a.md"] },
		});
	});

	it("publishes when the record write fails, and the next push writes it", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		failPutOnce(storage, pushKey("s1"));

		await publishManifestWithHistory(storage, key, "", s1, null, history);
		expect(await storage.exists(pushKey("s1"))).toBe(false);
		vi.mocked(storage.put).mockRestore();

		await publishManifestWithHistory(storage, key, "", s2, s1, history);
		expect(await storage.exists(pushKey("s1"))).toBe(true);
		expect(await storage.exists(pushKey("s2"))).toBe(true);
	});

	it("keeps the record of a failed publish waiting: its manifest may have landed", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		failPutOnce(storage, pushKey("lost"));
		const lost = manifestOf("lost", "x", { "a.md": "L" });

		await expect(
			publishManifestWithHistory(
				storage,
				key,
				"",
				lost,
				manifestOf("x", null, { "a.md": "X" }),
				history,
			),
		).rejects.toThrow(/changed since the last compare/);
		vi.mocked(storage.put).mockRestore();
		await publishManifestWithHistory(storage, key, "", s2, s1, history);

		expect(await storage.exists(pushKey("lost"))).toBe(true);
		expect(await storage.exists(pushKey("s2"))).toBe(true);
	});

	it("retries through an adapter rebuilt for the same storage", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		failPutOnce(storage, pushKey("s1"));
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		vi.mocked(storage.put).mockRestore();

		// A share move or a token refresh: a new adapter over the same objects.
		const rebuilt = Object.create(storage) as FakeStorage;
		await publishManifestWithHistory(rebuilt, key, "", s2, s1, history);
		expect(await storage.exists(pushKey("s1"))).toBe(true);
	});

	it("withholds a delayed record once a blob it names is swept", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		failPutOnce(storage, pushKey("s1"));
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		vi.mocked(storage.put).mockRestore();

		await storage.delete(objectKey("A1"));
		await publishManifestWithHistory(storage, key, "", s2, s1, history);
		expect(await storage.list("history/")).toEqual([pushKey("s2")]);
	});

	it("checks a record naming more than a listing page with one listing, not a probe per blob", async () => {
		const storage = new FakeStorage("big");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const hashes = Array.from({ length: 1001 }, (_, i) => `h${i}`);
		for (const hash of [...hashes, "A2"]) {
			await storage.put(objectKey(hash), new Uint8Array([1]));
		}
		const big = manifestOf(
			"big1",
			null,
			Object.fromEntries(hashes.map((hash) => [`${hash}.md`, hash])),
		);
		const next = manifestOf("big2", "big1", { "a.md": "A2" });
		failPutOnce(storage, pushKey("big1"));
		await publishManifestWithHistory(storage, key, "", big, null, history);
		vi.mocked(storage.put).mockRestore();
		storage.existsCalls = 0;
		storage.listCalls = 0;

		await publishManifestWithHistory(storage, key, "", next, big, history);

		expect(storage.existsCalls).toBe(0);
		expect(storage.listCalls).toBe(1);
		expect(storage.map.has(pushKey("big1"))).toBe(true);
		expect(storage.map.has(pushKey("big2"))).toBe(true);
	});

	it("withholds a record naming more than a listing page once one of its blobs is swept", async () => {
		const storage = new FakeStorage("big-swept");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const hashes = Array.from({ length: 1001 }, (_, i) => `h${i}`);
		for (const hash of [...hashes, "A2"]) {
			await storage.put(objectKey(hash), new Uint8Array([1]));
		}
		const big = manifestOf(
			"big1",
			null,
			Object.fromEntries(hashes.map((hash) => [`${hash}.md`, hash])),
		);
		const next = manifestOf("big2", "big1", { "a.md": "A2" });
		failPutOnce(storage, pushKey("big1"));
		await publishManifestWithHistory(storage, key, "", big, null, history);
		vi.mocked(storage.put).mockRestore();

		await storage.delete(objectKey("h500"));
		await publishManifestWithHistory(storage, key, "", next, big, history);

		expect(await storage.list("history/")).toEqual([pushKey("big2")]);
	});

	it("withholds a delayed record of another vault", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		failPutOnce(storage, pushKey("s1"));
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		vi.mocked(storage.put).mockRestore();

		// Reset elsewhere, its blobs still there: only the vault tells the record apart.
		await storage.delete(REMOTE_MANIFEST_KEY);
		const adopted = { ...manifestOf("w1", null, {}), vaultId: "w" };
		await publishManifestWithHistory(storage, key, "", adopted, null, history);
		expect(await storage.list("history/")).toEqual([pushKey("w1")]);
	});

	it("withholds a delayed record after the remote is reset", async () => {
		const storage = await stored();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		failPutOnce(storage, pushKey("s1"));
		await publishManifestWithHistory(storage, key, "", s1, null, history);
		vi.mocked(storage.put).mockRestore();

		await resetRemoteStorage(storage);
		await publishManifestWithHistory(storage, key, "", s2, null, history);
		expect(await storage.list("history/")).toEqual([pushKey("s2")]);
	});

	it("leaves the configuration folder out of the record and releases its versions", async () => {
		const storage = await stored();
		const before = manifestOf("c1", null, {
			"a.md": "A1",
			".obsidian/plugins/x/main.js": "M1",
		});
		const after = manifestOf("c2", "c1", {
			"a.md": "A2",
			".obsidian/plugins/x/main.js": "M2",
		});
		await publishManifestWithHistory(storage, key, "", before, null, history);

		await publishManifestWithHistory(
			storage,
			key,
			"",
			after,
			before,
			history,
			null,
			".obsidian",
		);

		const { view } = await readHistory(storage, key, "");
		const push = view.pushes.get(pushKey("c2"))?.push;
		expect(push?.changes.modified).toEqual({
			"a.md": { from: before.files["a.md"], to: after.files["a.md"] },
		});
		expect([...(push?.released ?? [])].sort()).toEqual(["M1", "M2"]);
	});

	it("writes no released list when the configuration folder did not change", async () => {
		const storage = await stored();
		const config = { ".obsidian/app.json": "J1" };
		const before = manifestOf("c1", null, { "a.md": "A1", ...config });
		const after = manifestOf("c2", "c1", { "a.md": "A2", ...config });
		await publishManifestWithHistory(storage, key, "", before, null, history);

		await publishManifestWithHistory(
			storage,
			key,
			"",
			after,
			before,
			history,
			null,
			".obsidian",
		);

		const { view } = await readHistory(storage, key, "");
		const push = view.pushes.get(pushKey("c2"))?.push;
		expect(push).toBeDefined();
		expect(push && Object.hasOwn(push, "released")).toBe(false);
	});

	it("writes no record with history off", async () => {
		const storage = await stored();
		await publishManifestWithHistory(storage, key, "", s1, null, undefined);
		expect(await storage.list("history/")).toEqual([]);
	});
});
