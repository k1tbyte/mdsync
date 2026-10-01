import { FakeStorage } from "@tests/helpers/fake-storage";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey, type EncryptionKey } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { REMOTE_MANIFEST_KEY, REMOTE_OBJECTS_PREFIX } from "@/sync/constants";
import { compare, type EngineDependencies, pushPaths } from "@/sync/engine";
import { VAULT_SPACE } from "@/sync/space";
import type { SessionState } from "@/sync/types";
import { UPLOAD_TRUST_MS } from "@/sync/uploads";
import { createScopePolicy } from "@/vault/scope";

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});
afterEach(() => {
	vi.restoreAllMocks();
});

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

/** One over the threshold at which a listing replaces per-object probes. */
const BIG = 257;

/** Counts object uploads; `offline` fails the publish after the uploads. */
class PushStorage extends FakeStorage {
	offline = false;
	objectPuts = 0;

	override put(name: string, body: Uint8Array): Promise<void> {
		if (this.offline && name === REMOTE_MANIFEST_KEY) {
			return Promise.reject(new Error("offline"));
		}
		if (name.startsWith(REMOTE_OBJECTS_PREFIX)) this.objectPuts++;
		return super.put(name, body);
	}

	reset(): void {
		this.offline = false;
		this.objectPuts = 0;
		this.existsCalls = 0;
	}
}

function freshState(): SessionState {
	return {
		deviceId: "A",
		deviceName: "A",
		vaultId: null,
		baseline: null,
		hashCache: {},
	};
}

function deps(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
): EngineDependencies {
	return {
		space: VAULT_SPACE,
		adapter: adapter.asDataAdapter(),
		storage,
		scope,
		key,
		state: freshState(),
		maxFileBytes: 1_000_000,
		concurrency: 4,
	};
}

async function pushAll(
	adapter: InMemoryAdapter,
	storage: FakeStorage,
): Promise<string[]> {
	const cmp = await compare(deps(adapter, storage));
	const paths = cmp.diff.localChanges.map((change) => change.path);
	await pushPaths(deps(adapter, storage), cmp, paths);
	return paths;
}

/** Uploads every blob, then fails to publish. */
async function pushOffline(
	adapter: InMemoryAdapter,
	storage: PushStorage,
): Promise<void> {
	storage.offline = true;
	await expect(pushAll(adapter, storage)).rejects.toThrow("offline");
	storage.reset();
}

function seed(adapter: InMemoryAdapter, count: number): void {
	for (let i = 0; i < count; i++) {
		adapter.putText(`note-${i}.md`, `body ${i}`);
	}
}

describe("upload existence probes", () => {
	it("uploads what it never uploaded without asking whether it is there", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, BIG);

		const paths = await pushAll(adapter, storage);

		expect(paths).toHaveLength(BIG);
		expect(storage.existsCalls).toBe(0);
		expect(storage.objectPuts).toBe(BIG);
	});

	it("resumes a push that did not publish from its own uploads", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, 3);
		await pushOffline(adapter, storage);

		await pushAll(adapter, storage);

		expect(storage.objectPuts).toBe(0);
		expect(storage.existsCalls).toBe(3);
	});

	it("lists once to resume a big push, confirming each object it names", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, BIG);
		await pushOffline(adapter, storage);
		storage.listCalls = 0;

		await pushAll(adapter, storage);

		expect(storage.objectPuts).toBe(0);
		expect(storage.listCalls).toBe(1);
		// A listing can name an object being deleted, so a positive is worth a probe.
		expect(storage.existsCalls).toBe(BIG);
	});

	it("falls back to probing when the backend refuses to list", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, BIG);
		await pushOffline(adapter, storage);
		storage.list = () => Promise.reject(new Error("ListObjects denied"));

		await pushAll(adapter, storage);

		expect(storage.objectPuts).toBe(0);
		expect(storage.existsCalls).toBe(BIG);
	});

	it("uploads again a blob outside the head it did not just upload, as GC may be sweeping it", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, 3);
		await pushAll(adapter, storage);
		// The blobs stay, the head no longer names them: like a version only history holds.
		storage.map.delete(REMOTE_MANIFEST_KEY);
		storage.reset();

		await pushAll(adapter, storage);

		expect(storage.existsCalls).toBe(0);
		expect(storage.objectPuts).toBe(3);
	});

	it("stops trusting its own uploads once deep clean may take them", async () => {
		const adapter = new InMemoryAdapter();
		const storage = new PushStorage();
		seed(adapter, 3);
		await pushOffline(adapter, storage);
		const later = Date.now() + UPLOAD_TRUST_MS;
		vi.spyOn(Date, "now").mockReturnValue(later);

		await pushAll(adapter, storage);

		expect(storage.existsCalls).toBe(0);
		expect(storage.objectPuts).toBe(3);
	});
});
