import { seeded } from "@tests/helpers/seeded";
import { diffManifests, undoChanges } from "@/features/sync/history/changes";
import { activityOf } from "@/features/sync/history/model/activity";
import {
	type Cover,
	coverOf,
	type HistoryView,
} from "@/features/sync/history/model/cover";
import { planGc } from "@/features/sync/history/model/plan";
import type {
	HistoryObject,
	PushRecord,
} from "@/features/sync/history/model/types";
import type { EFileKind, Manifest, ManifestEntry } from "@/features/sync/types";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const SETTLED = DAY;

/** FNV-1a: a stand-in for the store's SHA-256 digest. */
function digest(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/** Storage and devices in memory: pushes write records, GC applies plans the way the store will. */
export class HistorySim {
	readonly pushes = new Map<string, { push: PushRecord; at: number }>();
	readonly objects = new Map<string, { object: HistoryObject; at: number }>();
	readonly manifests = new Map<string, Manifest>();
	head: Manifest | null = null;
	pushCount = 0;
	/** Share of push records whose storage time straggles up to 15 min either way. */
	straggle = 0;
	/** Storage time. */
	now: number;
	private readonly random: () => number;

	constructor(
		seed: number,
		readonly horizon: number | null,
		start = Date.UTC(2026, 6, 1, 8, 0, 0),
		readonly vaultId = "vault",
	) {
		this.random = seeded(seed);
		this.now = start;
	}

	after(ms: number): number {
		this.now += ms;
		return this.now;
	}

	view(): HistoryView {
		return { pushes: this.pushes, objects: this.objects };
	}

	/** Writes the record; publishing makes it HEAD. */
	push(at: number, publish = true): Manifest {
		const parent = this.head;
		const files = { ...parent?.files };
		for (const path of ["a.md", "b.md", "c.md", "d/e.md", "f.md"]) {
			const roll = this.random();
			if (roll < 0.1) delete files[path];
			else if (roll < 0.5) files[path] = this.entry(at);
		}
		const manifest: Manifest = {
			version: 1,
			vaultId: this.vaultId,
			snapshotId: `s${this.manifests.size + 1}`,
			parentSnapshotId: parent?.snapshotId ?? null,
			createdAt: at,
			deviceId: "d",
			files,
		};
		this.manifests.set(manifest.snapshotId, manifest);
		this.pushes.set(`p/${manifest.snapshotId}`, {
			push: {
				v: 1,
				vaultId: this.vaultId,
				id: manifest.snapshotId,
				parentId: manifest.parentSnapshotId,
				createdAt: at,
				deviceId: "d",
				changes: diffManifests(parent, manifest),
			},
			at:
				this.straggle > 0 && this.random() < this.straggle
					? at + (this.random() - 0.5) * 30 * MINUTE
					: at,
		});
		if (publish) this.publish(manifest);
		return manifest;
	}

	publish(manifest: Manifest): void {
		this.head = manifest;
		this.pushCount++;
	}

	cover(): Cover {
		const head = this.head;
		return coverOf(
			this.view(),
			head && {
				id: head.snapshotId,
				parentId: head.parentSnapshotId,
				vaultId: head.vaultId,
			},
		);
	}

	/** One GC run at storage time `now`; returns how many writes and deletes it made. */
	gc(now: number): number {
		const plan = planGc({
			view: this.view(),
			cover: this.cover(),
			vaultId: this.head?.vaultId ?? this.vaultId,
			now,
			horizon: this.horizon,
			settledBefore: now - SETTLED,
		});
		for (const build of plan.builds) {
			const key = `b/${build.res}-${build.group}-${digest(
				JSON.stringify([build.records, build.activity, build.lastId]),
			)}`;
			const consumed = build.consumed.filter((named) => named !== key);
			this.objects.set(key, { object: { v: 1, ...build, consumed }, at: now });
			for (const named of consumed) this.drop(named);
		}
		for (const key of plan.deletes) this.drop(key);
		return plan.builds.length + plan.deletes.length;
	}

	/** Replays back from HEAD through the walked records; throws where a state differs from the push's. */
	checkReplay(cover: Cover): void {
		if (!this.head) return;
		const files = { ...this.head.files };
		for (const { record } of cover.chain) {
			const expected = this.manifests.get(record.id);
			if (!expected) throw new Error(`Unknown snapshot ${record.id}`);
			if (
				JSON.stringify(sorted(files)) !== JSON.stringify(sorted(expected.files))
			) {
				throw new Error(`Replay differs at ${record.id}`);
			}
			undoChanges(files, record.changes);
		}
		const reachedFirst = cover.chain.at(-1)?.record.parentId === null;
		if (reachedFirst && Object.keys(files).length > 0) {
			throw new Error("Replay past the first push left files behind");
		}
	}

	/** Pushes the walk and the counts objects account for. */
	countedPushes(cover: Cover): number {
		const activity = activityOf(this.view(), cover, this.vaultId);
		return Object.values(activity).reduce((sum, [pushes]) => sum + pushes, 0);
	}

	private drop(key: string): void {
		this.pushes.delete(key);
		this.objects.delete(key);
	}

	private entry(at: number): ManifestEntry {
		const hash = `h${Math.floor(this.random() * 4)}`;
		return { hash, size: hash.length, mtime: at, kind: "vault" as EFileKind };
	}
}

function sorted(
	files: Record<string, ManifestEntry>,
): [string, ManifestEntry][] {
	return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}
