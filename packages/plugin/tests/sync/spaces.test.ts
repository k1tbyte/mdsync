import { FakeStorage } from "@tests/helpers/fake-storage";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decryptJson, deriveKey, type EncryptionKey } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import { SyncController } from "@/sync/controller";
import { projectSession } from "@/sync/session-state";
import { nestedRoots, type Space, VAULT_SPACE } from "@/sync/space";
import type { LocalState, Manifest } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

let vaultKey: EncryptionKey;
let shareKey: EncryptionKey;

beforeAll(async () => {
	vaultKey = await deriveKey("vault", new Uint8Array(16));
	shareKey = await deriveKey("share", new Uint8Array(16));
});

interface Remote {
	vault: FakeStorage;
	share: FakeStorage;
}

function remote(): Remote {
	return { vault: new FakeStorage("vault"), share: new FakeStorage("share") };
}

/**
 * One device syncing its vault plus the share mounted at `root`, if any.
 * `mount` and `mark` change its records; a refresh picks the change up.
 */
function device(
	on: Remote,
	root: string | null,
	was?: { adapter: InMemoryAdapter; state: () => LocalState },
	flags: Pick<Space, "readOnly" | "paused"> = {},
) {
	const adapter = was?.adapter ?? new InMemoryAdapter();
	let local: LocalState = was?.state() ?? {
		deviceId: "d",
		storages: {},
		hashCache: {},
	};
	let mounted = root;
	let marks = flags;
	const controller = new SyncController({
		spaces: async () =>
			mounted === null
				? [VAULT_SPACE]
				: [VAULT_SPACE, { id: "share", root: mounted, ...marks }],
		openSession: async (space, partition) => {
			const storage = space === VAULT_SPACE ? on.vault : on.share;
			return {
				space,
				adapter: adapter.asDataAdapter(),
				storage,
				scope: createScopePolicy({
					settingsSync: DEFAULT_SETTINGS_SYNC,
					configDir: ".obsidian",
					root: space.root,
					otherRoots: nestedRoots(partition, space),
				}),
				key: space === VAULT_SPACE ? vaultKey : shareKey,
				state: projectSession(local, storage.identity(), space.root),
				maxFileBytes: 1_000_000,
				concurrency: 2,
			};
		},
		persistState: async (state) => {
			local = state;
		},
		getState: () => local,
		logInfo: vi.fn(async () => {}),
		logWarn: vi.fn(async () => {}),
		logError: vi.fn(async () => {}),
	});
	const mount = (next: string) => {
		mounted = next;
	};
	const mark = (next: typeof flags) => {
		marks = next;
	};
	return { adapter, controller, state: () => local, mount, mark };
}

async function publishedPaths(
	storage: FakeStorage,
	key: EncryptionKey,
): Promise<string[]> {
	const blob = await storage.get(REMOTE_MANIFEST_KEY);
	if (!blob) return [];
	return Object.keys((await decryptJson<Manifest>(key, blob)).files);
}

describe("spaces in the file sync", () => {
	it("pushes each space to its own storage, relative to its root", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("a.md", "A");
		laptop.adapter.putText("Shared/p/b.md", "B");

		await laptop.controller.refreshAndAutoSync();

		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["a.md"]);
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		expect(laptop.controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
		});
		expect(Object.keys(laptop.state().hashCache).sort()).toEqual([
			"Shared/p/b.md",
			"a.md",
		]);
	});

	it("mounts a share under each device's own folder and syncs edits both ways", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();

		const phone = device(on, "Mine/q");
		await phone.controller.refreshAndAutoSync();
		expect(phone.adapter.readText("Mine/q/b.md")).toBe("B");

		phone.adapter.putText("Mine/q/b.md", "B from the phone");
		await phone.controller.refreshAndAutoSync();
		await laptop.controller.refreshAndAutoSync();

		expect(laptop.adapter.readText("Shared/p/b.md")).toBe("B from the phone");
		expect(laptop.controller.getSnapshot().conflicts).toBe(0);
	});

	it("routes by the partition of the last refresh, not by newer records", async () => {
		const on = remote();
		const laptop = device(on, null);
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refresh();

		laptop.mount("Shared/p");
		await laptop.controller.pushPaths(["Shared/p/b.md"]);
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["Shared/p/b.md"]);
		expect(await publishedPaths(on.share, shareKey)).toEqual([]);

		await laptop.controller.refreshAndAutoSync();
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["Shared/p/b.md"]);
	});

	it("never auto-pushes into a read-only share, and says nothing of it", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();

		const reader = device(on, "Shared/p", undefined, { readOnly: true });
		await reader.controller.refreshAndAutoSync();
		reader.adapter.putText("Shared/p/b.md", "B from the reader");
		reader.adapter.putText("mine.md", "M");
		await reader.controller.refreshAndAutoSync();

		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["mine.md"]);
		expect(reader.controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 1,
		});

		// Nor by hand: the change stays until it is reverted.
		expect(await reader.controller.pushPaths(["Shared/p/b.md"])).toMatchObject({
			ok: false,
		});
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		await reader.controller.revertPaths(["Shared/p/b.md"]);
		await reader.controller.refresh();
		expect(reader.controller.getSnapshot().pendingLocal).toBe(0);
	});

	it("syncs nothing of a paused share here, nor lets the vault take it, then resumes", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();
		const phone = device(on, "Shared/p");
		await phone.controller.refreshAndAutoSync();

		phone.mark({ paused: true });
		laptop.adapter.putText("Shared/p/b.md", "B2");
		await laptop.controller.refreshAndAutoSync();
		phone.adapter.putText("Shared/p/c.md", "C");
		phone.adapter.putText("mine.md", "M");
		await phone.controller.refreshAndAutoSync();

		expect(phone.adapter.readText("Shared/p/b.md")).toBe("B");
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["mine.md"]);
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		expect(phone.controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
		});
		expect(await phone.controller.pushPaths(["Shared/p/c.md"])).toEqual({
			ok: false,
			error: '"Shared/p" is paused on this device.',
		});

		phone.mark({});
		await phone.controller.refreshAndAutoSync();
		expect(phone.adapter.readText("Shared/p/b.md")).toBe("B2");
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md", "c.md"]);
	});

	it("keeps the vault's copy of a folder frozen once it is shared", async () => {
		const on = remote();
		const before = device(on, null);
		before.adapter.putText("Shared/p/b.md", "B");
		await before.controller.refreshAndAutoSync();

		const after = device(on, "Shared/p", before);
		after.adapter.putText("Shared/p/c.md", "C");
		await after.controller.refreshAndAutoSync();

		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["Shared/p/b.md"]);
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md", "c.md"]);
	});
});
