import type { EncryptionKey } from "@/crypto";
import type { StorageAdapter } from "@/storage/types";
import type { Space } from "@/sync/space";

import { spacesOf } from "./partition";
import {
	closeRecord,
	mergeRecords,
	type ShareAccess,
	type SpaceRecord,
} from "./record";
import { syncRecords } from "./remote";

/** A folder the person moved on another device, still at `from` here. */
export interface PendingMove {
	id: string;
	from: string;
	to: string;
}

/** What a trade with the vault's storage did. */
export interface RecordsSync {
	/** This device published a record. */
	published: boolean;
	/** Open here until another device closed them. */
	closed: Space[];
	/** Open here until this device moved to another vault storage. */
	left: Space[];
}

interface Derived {
	spaces: SpaceRecord[];
	pausedSpaces: string[];
	localRoots: Record<string, string>;
	list: readonly SpaceRecord[];
	partition: readonly Space[];
}

/**
 * This device's working copy of the space records. It lives in the settings,
 * next to the storage credentials, because it is needed before the first pull.
 */
export class SpaceRecords {
	private derived: Derived | null = null;

	constructor(
		private readonly settings: {
			spaces: SpaceRecord[];
			pausedSpaces: string[];
			pauseArrivingShares: boolean;
			localRoots: Record<string, string>;
			spacesVault: string | null;
		},
		private readonly save: () => Promise<void>,
	) {}

	/** Roots as on this device: a folder not moved here yet keeps its old one. */
	list(): readonly SpaceRecord[] {
		return this.derive().list;
	}

	partition(): readonly Space[] {
		return this.derive().partition;
	}

	/** Open records left out because a smaller id holds their folder: only closing them helps. */
	inert(): SpaceRecord[] {
		const mounted = new Set(this.partition().map((space) => space.id));
		return this.list().filter(
			(record) => !record.closed && !mounted.has(record.id),
		);
	}

	moves(): PendingMove[] {
		const { spaces, localRoots } = this.settings;
		return spaces.flatMap(({ id, root }) => {
			const from = localRoots[id];
			return from === undefined ? [] : [{ id, from, to: root }];
		});
	}

	/** Published by the next `sync`, which every refresh runs first. */
	async add(record: SpaceRecord): Promise<void> {
		this.settings.spaces = mergeRecords(this.settings.spaces, [record]);
		await this.save();
	}

	/** Published like `add`; the folder leaves the partition from the next refresh. */
	async close(id: string, author: string): Promise<void> {
		const record = this.stored(id);
		if (!record || record.closed) return;
		this.settings.pausedSpaces = this.unpaused(id);
		this.dropLocalRoot(id);
		await this.add(closeRecord(record, author));
	}

	/**
	 * The folder is at `root` on this device now; a new root moves it on the person's
	 * other devices. The records change at once, the promise is the save.
	 */
	async moveRoot(id: string, root: string, author: string): Promise<void> {
		const record = this.stored(id);
		if (!record) return;
		if (record.root === root) return this.settle(id);
		this.dropLocalRoot(id);
		await this.add({ ...record, root, rev: record.rev + 1, author });
	}

	/** Remembers the relay an invite went through, so closing the share can end its tokens there. */
	async invitedVia(
		id: string,
		relayUrl: string,
		author: string,
	): Promise<void> {
		const record = this.stored(id);
		if (
			record?.access.kind !== "owner" ||
			record.access.relayUrl === relayUrl
		) {
			return;
		}
		const access = { ...record.access, relayUrl };
		await this.add({ ...record, access, rev: record.rev + 1, author });
	}

	/** A new invite link for a share open here: only its access changes, never its root. */
	async renew(id: string, access: ShareAccess, author: string): Promise<void> {
		const record = this.stored(id);
		if (!record || record.closed) return;
		await this.add({ ...record, access, rev: record.rev + 1, author });
	}

	/** The folder is where its record says now. */
	async settle(id: string): Promise<void> {
		this.dropLocalRoot(id);
		await this.save();
	}

	/** This device only: the person's other devices keep syncing the share. */
	async setPaused(id: string, paused: boolean): Promise<void> {
		this.settings.pausedSpaces = paused
			? [...this.unpaused(id), id]
			: this.unpaused(id);
		await this.save();
	}

	/**
	 * Trades records with the vault's storage and keeps what wins.
	 * A root moved elsewhere keeps the folder where it is here, in the same save, until it moves.
	 */
	async sync(
		storage: StorageAdapter,
		key: EncryptionKey,
	): Promise<RecordsSync> {
		const vault = storage.identity();
		const { spacesVault } = this.settings;
		// Another vault's records never reach this one, share keys and all.
		const foreign = spacesVault !== null && spacesVault !== vault;
		const { records, published } = await syncRecords(
			storage,
			key,
			foreign ? [] : this.settings.spaces,
		);
		// Bound once the trade went through, so a failed one is tried again whole.
		const left = spacesVault === vault ? null : this.bindTo(vault);
		// Merged again: a record added while the trade was in flight must stay.
		const merged = mergeRecords(records, this.settings.spaces);
		const here = this.list();
		const closed = merged.flatMap(({ id, closed }) => {
			const local = here.find((each) => each.id === id);
			return closed && local && !local.closed ? [{ id, root: local.root }] : [];
		});
		if (
			left !== null ||
			JSON.stringify(merged) !== JSON.stringify(this.settings.spaces)
		) {
			this.settings.localRoots = pendingRoots(here, merged, {
				...this.settings.localRoots,
			});
			this.repause(here, merged);
			this.settings.spaces = merged;
			await this.save();
		}
		return { published, closed, left: left ?? [] };
	}

	/**
	 * A closed share is paused no more; one new here arrives paused when this
	 * device asks so. In the records' own save, so no refresh pulls it first.
	 */
	private repause(
		here: readonly SpaceRecord[],
		merged: readonly SpaceRecord[],
	): void {
		const open = new Set(
			here.filter((each) => !each.closed).map(({ id }) => id),
		);
		const closed = new Set(
			merged.filter((each) => each.closed).map(({ id }) => id),
		);
		const arrived = this.settings.pauseArrivingShares
			? merged.filter(({ id }) => !closed.has(id) && !open.has(id))
			: [];
		this.settings.pausedSpaces = [
			...new Set([
				...this.settings.pausedSpaces.filter((id) => !closed.has(id)),
				...arrived.map(({ id }) => id),
			]),
		];
	}

	/**
	 * Records belong to the vault storage they were traded with. Pointed at another
	 * vault, this device drops them and their folders stay as plain files. Returns
	 * the shares it leaves.
	 */
	private bindTo(vault: string): Space[] {
		const { spacesVault } = this.settings;
		this.settings.spacesVault = vault;
		if (spacesVault === null) return [];
		const left = this.list().flatMap(({ id, root, closed }) =>
			closed ? [] : [{ id, root }],
		);
		this.settings.spaces = [];
		this.settings.pausedSpaces = [];
		this.settings.localRoots = {};
		return left;
	}

	private derive(): Derived {
		const { spaces, pausedSpaces, localRoots } = this.settings;
		const known = this.derived;
		if (
			known?.spaces === spaces &&
			known.pausedSpaces === pausedSpaces &&
			known.localRoots === localRoots
		) {
			return known;
		}
		const list = spaces.map((record) => {
			const root = localRoots[record.id];
			return root === undefined ? record : { ...record, root };
		});
		this.derived = {
			spaces,
			pausedSpaces,
			localRoots,
			list,
			partition: spacesOf(list, new Set(pausedSpaces)),
		};
		return this.derived;
	}

	private stored(id: string): SpaceRecord | undefined {
		return this.settings.spaces.find((each) => each.id === id);
	}

	private unpaused(id: string): string[] {
		return this.settings.pausedSpaces.filter((each) => each !== id);
	}

	private dropLocalRoot(id: string): void {
		const roots = { ...this.settings.localRoots };
		delete roots[id];
		this.settings.localRoots = roots;
	}
}

/** A closed folder is the vault's: never moved, wherever the record went. */
function pendingRoots(
	here: readonly SpaceRecord[],
	merged: readonly SpaceRecord[],
	roots: Record<string, string>,
): Record<string, string> {
	for (const record of merged) {
		const local = here.find((each) => each.id === record.id);
		if (record.closed || local?.root === record.root) delete roots[record.id];
		else if (local && !local.closed) roots[record.id] = local.root;
	}
	return roots;
}
