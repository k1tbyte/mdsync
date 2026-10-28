import { FakeStorage } from "@tests/helpers/fake-storage";
import {
	manifestOf,
	pinSnapshot,
	writePushRecord,
} from "@tests/helpers/history";
import { seeded } from "@tests/helpers/seeded";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { collectHistoryGarbage } from "@/features/sync/history/gc";
import { publishManifestWithHistory } from "@/features/sync/history/publish";
import {
	listSnapshots,
	resolveSnapshotManifest,
} from "@/features/sync/history/query";
import { readHistory } from "@/features/sync/history/remote";
import { objectKey } from "@/features/sync/remote/manifest";
import {
	deepCleanOrphans,
	verifyRemote,
} from "@/features/sync/runtime/maintenance";
import type { Manifest } from "@/features/sync/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 5);

let key: EncryptionKey;
beforeAll(async () => {
	key = await deriveKey("pw", new Uint8Array(16));
});
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(START);
});
afterEach(() => {
	vi.useRealTimers();
});

/** One device pushing through the real publish path; every hash it names is uploaded first. */
class Device {
	readonly published = new Map<string, Manifest>();
	head: Manifest | null = null;
	private files: Record<string, string> = {};
	private count = 0;

	constructor(
		readonly storage: FakeStorage,
		readonly history: { horizon: number | null },
	) {}

	async push(edit: (files: Record<string, string>) => void): Promise<void> {
		this.files = { ...this.files };
		edit(this.files);
		for (const hash of Object.values(this.files)) {
			if (!this.storage.map.has(objectKey(hash))) {
				await this.storage.put(objectKey(hash), new Uint8Array([1]));
			}
		}
		const id = `s${++this.count}`;
		const manifest = manifestOf(
			id,
			this.head?.snapshotId ?? null,
			this.files,
			Date.now(),
		);
		await publishManifestWithHistory(
			this.storage,
			key,
			"",
			manifest,
			this.head,
			this.history,
		);
		this.head = manifest;
		this.published.set(id, manifest);
	}

	gc() {
		return collectHistoryGarbage(this.storage, key, "", this.history);
	}
}

/** Every listed snapshot replays to exactly the files it published. */
async function expectReplays(device: Device): Promise<string[]> {
	const source = { storage: device.storage, key, root: "" };
	const { snapshots } = await listSnapshots({ ...source, horizon: null });
	for (const { id, restorable } of snapshots) {
		expect(restorable).toBe(true);
		const replayed = await resolveSnapshotManifest(source, id);
		expect(replayed?.files).toEqual(device.published.get(id)?.files);
	}
	return snapshots.map(({ id }) => id);
}

async function pushEvery(
	device: Device,
	step: number,
	count: number,
	random = seeded(1),
): Promise<void> {
	for (let n = 0; n < count; n++) {
		vi.setSystemTime(Date.now() + step);
		await device.push((files) => {
			const path = `note-${Math.floor(random() * 6)}.md`;
			if (random() < 0.2) delete files[path];
			else files[path] = `h${n}`;
		});
	}
}

describe("collectHistoryGarbage", () => {
	it("thins aged pushes, keeps every remaining snapshot replayable, and a rerun changes nothing", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		const before = await expectReplays(device);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push((files) => {
			files["last.md"] = "L";
		});

		const run = await device.gc();
		expect(run.written).toBeGreaterThan(0);
		expect(run.retired).toBeGreaterThan(0);
		const after = await expectReplays(device);
		expect(after.length).toBeLessThan(before.length + 1);
		expect(after[0]).toBe(device.head?.snapshotId);

		expect(await device.gc()).toMatchObject({
			written: 0,
			retired: 0,
			swept: 0,
		});
	});

	it("reads the objects it wrote from the cache, with no GET", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		const run = await device.gc();
		expect(run.written).toBeGreaterThan(0);

		const get = vi.spyOn(device.storage, "get");
		const { view, unreadable } = await readHistory(device.storage, key, "");
		expect(unreadable).toEqual([]);
		expect(view.objects.size).toBe(run.written);
		expect(get).not.toHaveBeenCalled();
	});

	it("lists packed snapshots at their period, with every push still counted", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		await device.gc();

		const { snapshots, activity } = await listSnapshots({
			storage: device.storage,
			key,
			root: "",
			horizon: null,
		});
		expect(snapshots[0]?.res).toBe("push");
		expect(new Set(snapshots.map((s) => s.res))).toContain("1h");
		expect(snapshots.reduce((sum, s) => sum + s.pushes, 0)).toBe(61);
		const counted = Object.values(activity).reduce((sum, [n]) => sum + n, 0);
		expect(counted).toBe(61);
		for (const s of snapshots) expect(s.firstAt).toBeLessThanOrEqual(s.at);
	});

	it("sweeps the versions it freed only a day later, and leaves nothing dangling", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		const blobs = (): number =>
			[...device.storage.map.keys()].filter((k) => k.startsWith("objects/"))
				.length;

		const uploaded = blobs();
		expect((await device.gc()).swept).toBe(0);
		expect(blobs()).toBe(uploaded);

		vi.setSystemTime(Date.now() + DAY + MINUTE);
		expect((await device.gc()).swept).toBeGreaterThan(0);
		expect(blobs()).toBeLessThan(uploaded);
		expect(
			(await verifyRemote(device.storage, key, "", false)).missing,
		).toEqual([]);
		await expectReplays(device);
		expect(await device.storage.list("history/g/")).toEqual([]);
	});

	it("holds what it freed from a deep clean for a day, and from one that cannot read the record", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		const blobs = (): number =>
			[...device.storage.map.keys()].filter((k) => k.startsWith("objects/"))
				.length;
		const uploaded = blobs();
		await device.gc();

		expect(
			(await deepCleanOrphans(device.storage, key, "")).deletedObjects,
		).toBe(0);
		expect(blobs()).toBe(uploaded);

		const [file] = await device.storage.list("history/g/");
		const intact = device.storage.map.get(file as string) as Uint8Array;
		device.storage.map.set(file as string, new Uint8Array([1]));
		await expect(deepCleanOrphans(device.storage, key, "")).rejects.toThrow(
			/could not be read/,
		);
		device.storage.map.set(file as string, intact);

		vi.setSystemTime(Date.now() + DAY + MINUTE);
		expect(
			(await deepCleanOrphans(device.storage, key, "")).deletedObjects,
		).toBeGreaterThan(0);
		expect(await device.storage.list("history/g/")).toEqual([]);
		await expectReplays(device);
	});

	it("keeps a freed version a pin holds by the time it sweeps", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 60);
		const old = device.published.get("s3") as Manifest;
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		await device.gc();

		await pinSnapshot(device.storage, key, old);
		vi.setSystemTime(Date.now() + DAY + MINUTE);
		await device.gc();
		for (const { hash } of Object.values(old.files)) {
			expect(await device.storage.exists(objectKey(hash))).toBe(true);
		}
	});

	it("drops versions past the horizon to counts, and their blobs a day later", async () => {
		const device = new Device(new FakeStorage(), { horizon: 7 * DAY });
		await pushEvery(device, 3 * HOUR, 40);
		vi.setSystemTime(Date.now() + 70 * DAY);
		await device.push(() => {});
		await device.gc();
		vi.setSystemTime(Date.now() + DAY + MINUTE);
		await device.gc();

		const snapshots = await expectReplays(device);
		expect(snapshots.length).toBeLessThan(5);
		expect(
			(await verifyRemote(device.storage, key, "", false)).missing,
		).toEqual([]);
		expect(device.storage.map.has(objectKey("h0"))).toBe(false);
	});

	it("stops before writing anything when a history object cannot be read", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 20);
		vi.setSystemTime(Date.now() + 2 * DAY);
		await device.push(() => {});
		await device.storage.put("history/b/push-0-bad.enc", new Uint8Array([1]));
		const keys = [...device.storage.map.keys()].sort();

		await expect(device.gc()).rejects.toThrow(/could not be read/);
		expect([...device.storage.map.keys()].sort()).toEqual(keys);
	});

	it("retires a settled push that lost the guard and another vault's records", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, MINUTE, 3);
		const s1 = device.published.get("s1") as Manifest;
		await writePushRecord(
			device.storage,
			key,
			manifestOf("lost", "s1", { "x.md": "X" }),
			s1,
		);
		await writePushRecord(
			device.storage,
			key,
			{ ...manifestOf("old", null, {}), vaultId: "gone" },
			null,
		);
		vi.setSystemTime(Date.now() + DAY + MINUTE);
		await device.push(() => {});

		await device.gc();
		expect(await device.storage.exists("history/p/lost.enc")).toBe(false);
		expect(await device.storage.exists("history/p/old.enc")).toBe(false);
	});

	it("does nothing on a storage that cannot date its objects", async () => {
		const device = new Device(new FakeStorage(), { horizon: null });
		await pushEvery(device, 7 * MINUTE, 20);
		vi.setSystemTime(Date.now() + 2 * DAY);
		Object.assign(device.storage, { listDetailed: undefined });

		expect(await device.gc()).toEqual({
			written: 0,
			retired: 0,
			swept: 0,
			activity: null,
		});
	});

	it("holds every promise over a seeded season of pushes and GC runs", async () => {
		const random = seeded(7);
		const device = new Device(new FakeStorage(), { horizon: 14 * DAY });
		for (let n = 0; n < 240; n++) {
			vi.setSystemTime(Date.now() + Math.floor(random() * 6 * HOUR));
			await device.push((files) => {
				const path = `note-${Math.floor(random() * 8)}.md`;
				if (random() < 0.15) delete files[path];
				else files[path] = `h${n}`;
			});
			if (random() < 0.5) await device.gc();
		}
		vi.setSystemTime(Date.now() + DAY + MINUTE);
		await device.gc();

		await expectReplays(device);
		expect(
			(await verifyRemote(device.storage, key, "", false)).missing,
		).toEqual([]);
	});
});
