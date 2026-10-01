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
import type { VaultIndex } from "@/vault/file-index";
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
	let guest = false;
	let index: VaultIndex | undefined;
	const unindexed: number[] = [];
	const controller = new SyncController({
		spaces: async () =>
			mounted === null
				? [VAULT_SPACE]
				: [VAULT_SPACE, { id: "share", root: mounted, ...marks }],
		openSession: async (space, partition) => {
			if (guest && space === VAULT_SPACE) return null;
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
				index,
				state: projectSession(local, storage.identity(), space.root),
				maxFileBytes: 1_000_000,
				concurrency: 2,
				history: { maxSnapshots: 50 },
			};
		},
		persistState: async (state) => {
			local = state;
		},
		getState: () => local,
		logInfo: vi.fn(async () => {}),
		logWarn: vi.fn(async () => {}),
		logError: vi.fn(async () => {}),
		onUnindexed: (count) => unindexed.push(count),
	});
	/** Sessions read this index instead of walking the disk. */
	const useIndex = (next: VaultIndex) => {
		index = next;
	};
	const mount = (next: string | null) => {
		mounted = next;
	};
	const mark = (next: typeof flags) => {
		marks = next;
	};
	/** No vault storage: its session never opens, the share's does. */
	const beGuest = (next: boolean) => {
		guest = next;
	};
	return {
		adapter,
		controller,
		state: () => local,
		mount,
		mark,
		beGuest,
		useIndex,
		unindexed,
	};
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

	it("refreshes only the signalled share and keeps other spaces' results and hashes", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("a.md", "Vault");
		laptop.adapter.putText("Shared/p/b.md", "Share");
		await laptop.controller.refreshAndAutoSync();
		const phone = device(on, "Mine/q");
		await phone.controller.refreshAndAutoSync();
		laptop.adapter.putText("Shared/p/new.md", "New");
		await laptop.controller.refreshAndAutoSync();
		const vaultGet = vi.spyOn(on.vault, "get");
		const shareGet = vi.spyOn(on.share, "get");
		await phone.controller.refreshAndAutoPull(new Set(["share"]));
		expect(vaultGet).not.toHaveBeenCalled();
		expect(
			shareGet.mock.calls.filter(([key]) => key === REMOTE_MANIFEST_KEY),
		).toHaveLength(1);
		expect(phone.adapter.readText("Mine/q/new.md")).toBe("New");
		expect(Object.keys(phone.state().hashCache).sort()).toEqual([
			"Mine/q/b.md",
			"Mine/q/new.md",
			"a.md",
		]);
		expect(phone.controller.remoteHas("a.md")).toBe(true);
	});

	it("rediscovers changed share records on a vault signal", async () => {
		const on = remote();
		const phone = device(on, "Mine/q");
		phone.adapter.putText("a.md", "Vault");
		await phone.controller.refreshAndAutoSync();
		phone.mount(null);
		await phone.controller.refreshAndAutoPull(new Set([VAULT_SPACE.id]));
		expect(phone.controller.spaceFor("Mine/q/note.md")).toBe(VAULT_SPACE);
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

	it("settles a share that lost every file here: restored, or deleted for everyone", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/a.md", "A");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();
		const loseAll = async (paths: string[], fresh: string) => {
			for (const path of paths) await laptop.adapter.remove(path);
			laptop.adapter.putText(fresh, "new");
			await laptop.controller.refreshAndAutoSync();
		};

		await loseAll(["Shared/p/a.md", "Shared/p/b.md"], "Shared/p/new.md");
		expect(await publishedPaths(on.share, shareKey)).toEqual(["a.md", "b.md"]);
		expect(laptop.controller.getSnapshot().spaceErrors).toMatchObject([
			{ root: "Shared/p", gone: true },
		]);

		const share = laptop.controller.spaceFor("Shared/p");
		await laptop.controller.settleGone(share, "restore");
		expect(laptop.adapter.readText("Shared/p/a.md")).toBe("A");
		expect(laptop.adapter.readText("Shared/p/new.md")).toBe("new");
		expect(laptop.controller.getSnapshot().spaceErrors).toEqual([]);

		await laptop.controller.refreshAndAutoSync();
		await loseAll(
			["Shared/p/a.md", "Shared/p/b.md", "Shared/p/new.md"],
			"Shared/p/other.md",
		);
		await laptop.controller.settleGone(share, "delete");
		expect(await publishedPaths(on.share, shareKey)).toEqual(["other.md"]);
		expect(laptop.controller.getSnapshot().spaceErrors).toEqual([]);
	});

	it("lists the disk at the first full refresh and when asked, for files the index missed", async () => {
		const on = remote();
		const laptop = device(on, null);
		laptop.useIndex({
			configDir: ".obsidian",
			files: () => [],
			folders: () => [],
			rename: async () => false,
		});
		laptop.adapter.putText("a.md", "copied in behind Obsidian's back");

		await laptop.controller.refresh();
		expect(laptop.controller.getSnapshot().pendingLocal).toBe(1);
		// Remembered past the walk, so later compares can push it.
		await laptop.controller.refresh();
		expect(laptop.controller.getSnapshot().pendingLocal).toBe(1);
		expect((await laptop.controller.pushPaths(["a.md"])).ok).toBe(true);
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["a.md"]);

		await laptop.controller.refreshFromDisk();
		expect(laptop.unindexed).toEqual([1, 1]);
	});

	it("pulls a new shared file on a signal while this device has unpushed edits", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();
		const phone = device(on, "Mine/q");
		await phone.controller.refreshAndAutoSync();

		phone.adapter.putText("Mine/q/b.md", "B from the phone");
		laptop.adapter.putText("Shared/p/new.md", "N");
		await laptop.controller.refreshAndAutoSync();
		await phone.controller.refreshAndAutoPull();

		expect(phone.adapter.readText("Mine/q/new.md")).toBe("N");
		expect(phone.adapter.readText("Mine/q/b.md")).toBe("B from the phone");
		expect(phone.controller.getSnapshot()).toMatchObject({
			pendingLocal: 1,
			conflicts: 0,
		});
	});

	it("syncs a joined share with no vault storage, then the vault without the share's files", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();

		const own = { ...on, vault: new FakeStorage("guest") };
		const guest = device(own, "Mine/q");
		guest.beGuest(true);
		guest.adapter.putText("note.md", "Mine");
		guest.adapter.putText("Mine/q/c.md", "C");
		await guest.controller.refreshAndAutoSync();
		expect(guest.adapter.readText("Mine/q/b.md")).toBe("B");
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md", "c.md"]);
		expect(await own.vault.list("")).toEqual([]);

		guest.beGuest(false);
		await guest.controller.refreshAndAutoSync();
		expect(await publishedPaths(own.vault, vaultKey)).toEqual(["note.md"]);

		laptop.adapter.putText("Shared/p/b.md", "B again");
		await laptop.controller.refreshAndAutoSync();
		await guest.controller.refreshAndAutoSync();
		expect(guest.adapter.readText("Mine/q/b.md")).toBe("B again");
		expect(guest.controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
			conflicts: 0,
		});
	});

	it("pushes a share's changes on their own, never the vault's nor a read-only share's", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		await laptop.controller.refreshAndAutoSync();
		laptop.adapter.putText("a.md", "A");
		laptop.adapter.putText("Shared/p/b.md", "B");

		await laptop.controller.autoPushShares(new Set(["a.md", "Shared/p/b.md"]));
		expect([
			await publishedPaths(on.vault, vaultKey),
			await publishedPaths(on.share, shareKey),
		]).toEqual([[], ["b.md"]]);

		laptop.mark({ readOnly: true });
		await laptop.controller.refresh();
		laptop.adapter.putText("Shared/p/c.md", "C");
		await laptop.controller.autoPushShares(new Set(["Shared/p/c.md"]));
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
	});

	it("partitions first when a share's change comes before any refresh", async () => {
		const on = remote();
		const laptop = device(on, "Shared/p");
		laptop.adapter.putText("Shared/p/b.md", "B");

		await laptop.controller.autoPushShares(new Set(["Shared/p/b.md"]));
		expect([
			await publishedPaths(on.vault, vaultKey),
			await publishedPaths(on.share, shareKey),
		]).toEqual([[], ["b.md"]]);
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
		expect(
			await reader.controller.pushHunks(
				"Shared/p/b.md",
				new Map([[0, new Set([0])]]),
			),
		).toMatchObject({ ok: false });
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
		await expect(
			phone.controller.history.getFileHistory("Shared/p/b.md"),
		).rejects.toThrow('"Shared/p" is paused on this device.');

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

	it("drops the vault's copy of a shared folder from its manifest at the next vault push", async () => {
		const on = remote();
		const before = device(on, null);
		before.adapter.putText("Shared/p/b.md", "B");
		await before.controller.refreshAndAutoSync();

		const after = device(on, "Shared/p", before);
		after.adapter.putText("mine.md", "M");
		await after.controller.refreshAndAutoSync();

		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["mine.md"]);
		expect(await publishedPaths(on.share, shareKey)).toEqual(["b.md"]);
		expect(after.state().storages.vault?.baseline?.files).not.toHaveProperty(
			"Shared/p/b.md",
		);
	});

	it("returns a closed share's folder to the vault without reading it as deleted, on a device that never pushed the drop", async () => {
		const on = remote();
		const owner = device(on, null);
		owner.adapter.putText("Shared/p/b.md", "B");
		await owner.controller.refreshAndAutoSync();

		const idle = device(on, null);
		await idle.controller.refreshAndAutoSync();
		expect(idle.adapter.readText("Shared/p/b.md")).toBe("B");

		owner.mount("Shared/p");
		owner.adapter.putText("mine.md", "M");
		await owner.controller.refreshAndAutoSync();
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["mine.md"]);

		idle.mount("Shared/p");
		await idle.controller.refreshAndAutoSync();
		idle.mount(null);
		await idle.controller.refreshAndAutoSync();

		expect(idle.adapter.readText("Shared/p/b.md")).toBe("B");
		expect(idle.controller.getSnapshot()).toMatchObject({
			error: null,
			conflicts: 0,
		});
		expect(await publishedPaths(on.vault, vaultKey)).toEqual([
			"Shared/p/b.md",
			"mine.md",
		]);
	});

	/** The owner shares `Shared/p` and pushes the drop; the laptop has the share paused. */
	async function sharedWhilePaused() {
		const on = remote();
		const owner = device(on, null);
		owner.adapter.putText("Shared/p/b.md", "B");
		await owner.controller.refreshAndAutoSync();
		const laptop = device(on, null);
		await laptop.controller.refreshAndAutoSync();

		owner.mount("Shared/p");
		owner.adapter.putText("mine.md", "M");
		await owner.controller.refreshAndAutoSync();
		laptop.mark({ paused: true });
		laptop.mount("Shared/p");
		await laptop.controller.refreshAndAutoSync();
		return { on, laptop };
	}

	it("keeps the dropped frozen entry as a live merge base until the share here holds the path", async () => {
		const { laptop } = await sharedWhilePaused();

		const vault = laptop.state().storages.vault;
		expect(vault?.baseline?.files).not.toHaveProperty("Shared/p/b.md");
		expect(vault?.shareBases).toHaveProperty("Shared/p/b.md");
		const base = await laptop.controller.fileDiffs.loadBaselineForPath(
			"Shared/p/b.md",
			VAULT_SPACE,
		);
		expect(base?.text).toBe("B");

		laptop.mark({});
		await laptop.controller.refreshAndAutoSync();
		await laptop.controller.refreshAndAutoSync();
		expect(laptop.state().storages.vault).not.toHaveProperty("shareBases");
	});

	it("lets the merge base go without a deletion when the share closes before it was pulled", async () => {
		const { on, laptop } = await sharedWhilePaused();

		laptop.mount(null);
		await laptop.controller.refreshAndAutoSync();

		expect(laptop.state().storages.vault).not.toHaveProperty("shareBases");
		expect(laptop.adapter.readText("Shared/p/b.md")).toBe("B");
		expect(await publishedPaths(on.vault, vaultKey)).toEqual([
			"Shared/p/b.md",
			"mine.md",
		]);
	});

	it("keeps its baseline of a shared folder while the vault still lists it, so an edit made before closing is no conflict", async () => {
		const on = remote();
		const laptop = device(on, null);
		laptop.adapter.putText("Shared/p/b.md", "B");
		await laptop.controller.refreshAndAutoSync();

		laptop.mount("Shared/p");
		await laptop.controller.refreshAndAutoSync();
		laptop.adapter.putText("Shared/p/b.md", "B edited in the share");
		await laptop.controller.refreshAndAutoSync();
		laptop.mount(null);
		await laptop.controller.refreshAndAutoSync();

		expect(laptop.controller.getSnapshot()).toMatchObject({
			error: null,
			conflicts: 0,
		});
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["Shared/p/b.md"]);
	});

	it("keeps a shared folder's files out of the Trash and out of a vault restore", async () => {
		const on = remote();
		const before = device(on, null);
		before.adapter.putText("Shared/p/b.md", "B");
		before.adapter.putText("a.md", "A1");
		await before.controller.refreshAndAutoSync();

		const after = device(on, "Shared/p", before);
		after.adapter.putText("a.md", "A2");
		await after.controller.refreshAndAutoSync();
		expect(await publishedPaths(on.vault, vaultKey)).toEqual(["a.md"]);

		const { files } = await after.controller.history.listDeletedFiles();
		expect(files).toEqual([]);

		const { snapshots } = await after.controller.history.listSnapshots();
		const first = snapshots[snapshots.length - 1];
		const plan = await after.controller.history.previewVaultRestore(
			first?.id ?? "",
		);
		expect(plan.write.map(({ path }) => path)).toEqual(["a.md"]);
		expect(plan.remove).toEqual([]);
	});
});
