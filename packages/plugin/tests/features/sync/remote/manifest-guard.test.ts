import { FakeStorage } from "@tests/helpers/fake-storage";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/core/crypto/cipher";
import { REMOTE_MANIFEST_KEY } from "@/features/sync/constants";
import {
	ConcurrentPushError,
	fetchRemoteManifest,
	publishManifestWithGuard,
	reconcileRemoteAgainstBaseline,
} from "@/features/sync/remote/manifest";
import { EFileKind, type Manifest } from "@/features/sync/types";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});

function manifest(snapshotId: string, parent: string | null): Manifest {
	return {
		version: 1,
		vaultId: "vault",
		snapshotId,
		parentSnapshotId: parent,
		createdAt: 0,
		deviceId: "device-a",
		files: {},
	};
}

async function seed(storage: FakeStorage, head: Manifest): Promise<void> {
	storage.map.set(REMOTE_MANIFEST_KEY, await encryptJson(key, head));
}

class StaleReadStorage extends FakeStorage {
	staleBlob: Uint8Array | null = null;
	/** Manifest reads that still get `staleBlob`, then the storage catches up. */
	staleReads = Number.POSITIVE_INFINITY;

	override async get(objectKey: string): Promise<Uint8Array | null> {
		if (
			objectKey === REMOTE_MANIFEST_KEY &&
			this.staleBlob &&
			this.staleReads-- > 0
		) {
			return this.staleBlob;
		}
		return super.get(objectKey);
	}
}

describe("reconcileRemoteAgainstBaseline", () => {
	it("recovers a complete published head even when only part of it is in the baseline", async () => {
		const storage = new FakeStorage();
		const parent = manifest("s1", null);
		await seed(storage, parent);
		const entry = { hash: "h", size: 1, mtime: 0, kind: EFileKind.Vault };
		const published = {
			...manifest("s2", "s1"),
			files: { "acknowledged.md": entry, "remote-only.md": entry },
		};
		await publishManifestWithGuard(storage, key, "", published, "s1");
		const baseline = { ...published, files: { "acknowledged.md": entry } };
		expect(
			reconcileRemoteAgainstBaseline(parent, baseline, storage, key)?.files,
		).toEqual(published.files);
	});
	it("refuses to use a partial or persisted baseline as a complete remote head", () => {
		const baseline = manifest("s2", "s1");
		const remote = manifest("s1", null);
		expect(() => reconcileRemoteAgainstBaseline(remote, baseline)).toThrow(
			"older manifest",
		);
	});

	it("accepts a genuinely newer remote", () => {
		const baseline = manifest("s2", "s1");
		const remote = manifest("s3", "s2");
		expect(reconcileRemoteAgainstBaseline(remote, baseline)).toBe(remote);
	});

	it("passes through when either side is missing", () => {
		expect(
			reconcileRemoteAgainstBaseline(null, manifest("s1", null)),
		).toBeNull();
		const remote = manifest("s1", null);
		expect(reconcileRemoteAgainstBaseline(remote, null)).toBe(remote);
	});
});

describe("publishManifestWithGuard", () => {
	it("publishes when the head is still where we left it", async () => {
		const storage = new FakeStorage();
		const head = manifest("s1", null);
		await seed(storage, head);

		await publishManifestWithGuard(
			storage,
			key,
			"",
			manifest("s2", "s1"),
			"s1",
			head,
		);

		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s2",
		);
	});

	it("publishes the first manifest against an empty remote", async () => {
		const storage = new FakeStorage();
		await publishManifestWithGuard(
			storage,
			key,
			"",
			manifest("s1", null),
			null,
		);
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s1",
		);
	});

	it("refuses when another device pushed in between", async () => {
		const storage = new FakeStorage();
		const theirs = manifest("s9", "s1");
		await seed(storage, theirs);

		await expect(
			publishManifestWithGuard(
				storage,
				key,
				"",
				manifest("s2", "s1"),
				"s1",
				manifest("s1", null),
			),
		).rejects.toBeInstanceOf(ConcurrentPushError);
		// The competing head must survive intact.
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s9",
		);
	});

	it("refuses a first push onto a remote that already has a vault", async () => {
		const storage = new FakeStorage();
		await seed(storage, manifest("s1", null));

		await expect(
			publishManifestWithGuard(storage, key, "", manifest("s2", null), null),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});

	it("survives a backend still serving our previous write", async () => {
		const storage = new StaleReadStorage();
		const baseline = manifest("s2", "s1");
		await seed(storage, manifest("s1", null));
		await publishManifestWithGuard(storage, key, "", baseline, "s1");
		// Read path is one publish behind for the precheck and the first verify.
		storage.staleBlob = await encryptJson(key, manifest("s1", null));
		storage.staleReads = 2;

		await publishManifestWithGuard(
			storage,
			key,
			"",
			manifest("s3", "s2"),
			"s2",
			baseline,
		);

		storage.staleBlob = null;
		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s3",
		);
	});

	// Verify retries wait between reads; fire them at once.
	beforeEach(() => {
		vi.spyOn(window, "setTimeout").mockImplementation(((fn: () => void) => {
			fn();
			return 0;
		}) as typeof window.setTimeout);
	});
	afterEach(() => vi.restoreAllMocks());

	/** The verify reads back the head it replaced, `reads` times. */
	async function staleAfterPush(reads: number) {
		const storage = new StaleReadStorage();
		const head = manifest("s1", null);
		await seed(storage, head);
		const staleAfterWrite = await encryptJson(key, head);
		const originalPut = storage.put.bind(storage);
		storage.put = async (objectKey, body) => {
			await originalPut(objectKey, body);
			if (objectKey !== REMOTE_MANIFEST_KEY) return;
			storage.staleBlob = staleAfterWrite;
			storage.staleReads = reads;
		};
		return { storage, head };
	}

	it("reads again while the storage still shows the manifest we replaced", async () => {
		const { storage, head } = await staleAfterPush(1);

		await publishManifestWithGuard(
			storage,
			key,
			"",
			manifest("s2", "s1"),
			"s1",
			head,
		);

		expect((await fetchRemoteManifest(storage, key, ""))?.snapshotId).toBe(
			"s2",
		);
	});

	it("never calls a push done that it could not read back", async () => {
		const { storage, head } = await staleAfterPush(Number.POSITIVE_INFINITY);

		await expect(
			publishManifestWithGuard(
				storage,
				key,
				"",
				manifest("s2", "s1"),
				"s1",
				head,
			),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});

	it("reports a manifest overwritten right after our push", async () => {
		const storage = new StaleReadStorage();
		const head = manifest("s1", null);
		await seed(storage, head);

		const originalPut = storage.put.bind(storage);
		storage.put = async (objectKey, body) => {
			await originalPut(objectKey, body);
			if (objectKey === REMOTE_MANIFEST_KEY) {
				storage.staleBlob = await encryptJson(key, manifest("s9", "s1"));
			}
		};

		await expect(
			publishManifestWithGuard(
				storage,
				key,
				"",
				manifest("s2", "s1"),
				"s1",
				head,
			),
		).rejects.toBeInstanceOf(ConcurrentPushError);
	});
});

describe("fetchRemoteManifest", () => {
	it("refuses a manifest written by a newer plugin version", async () => {
		const storage = new FakeStorage();
		storage.map.set(
			REMOTE_MANIFEST_KEY,
			await encryptJson(key, { ...manifest("s1", null), version: 999 }),
		);
		await expect(fetchRemoteManifest(storage, key, "")).rejects.toThrow(
			/requires a newer MDSync/,
		);
	});

	it("returns null for an empty remote", async () => {
		expect(await fetchRemoteManifest(new FakeStorage(), key, "")).toBeNull();
	});
});
