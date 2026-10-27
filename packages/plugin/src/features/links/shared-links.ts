import type { EncryptionKey } from "@/core/crypto";
import type { StorageAdapter } from "@/features/storage";

import {
	detachedLinks,
	type LinkRecord,
	renamedLinks,
	type StoredLink,
} from "./record";
import { tradeLinks } from "./remote";

const MS_PER_S = 1000;
/** setTimeout's ceiling; a later expiry just takes another lap. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export interface SharedLinksDeps {
	/** Asked each time: a settings import replaces the object. */
	settings(): { links: StoredLink[] };
	save(): Promise<void>;
	/** This device, which signs each edit. */
	author(): string;
	/** A link was added or removed here: the person's other devices should learn of it soon. */
	announce(): void;
}

/** A change of the list; null when it changed nothing. */
type Edit = (links: readonly StoredLink[]) => StoredLink[] | null;

/** A new link, before this device signs it. */
export type NewLink = Omit<LinkRecord, "rev" | "author">;

/** The one owner of this person's share links: each change is saved and told to the subscribers. */
export class SharedLinks {
	private readonly listeners = new Set<() => void>();
	private expiryTimer: number | null = null;
	/** Edits made while a trade runs, replayed onto what it settled. */
	private pending: Edit[] | null = null;

	constructor(private readonly deps: SharedLinksDeps) {}

	all(): readonly LinkRecord[] {
		return this.deps.settings().links.filter((record) => !record.removed);
	}

	/** The links the note at `path` feeds; those of a deleted note stay under {@link all}. */
	of(path: string): LinkRecord[] {
		return this.all().filter(
			(record) => !record.detached && record.path === path,
		);
	}

	async add(link: NewLink): Promise<LinkRecord> {
		const record: LinkRecord = { ...link, rev: 0, author: this.deps.author() };
		await this.edit((links) => [...links, record]);
		this.deps.announce();
		return record;
	}

	/**
	 * Hidden at once, forgotten once the next trade deleted it from the vault storage: any trade, a failed one
	 * too, may have written it there already.
	 */
	async remove(id: string): Promise<void> {
		const removed = await this.edit((links) => {
			const at = links.find((record) => record.id === id);
			if (!at || at.removed) return null;
			return links.map((record) =>
				record === at ? { ...record, removed: true as const } : record,
			);
		});
		if (removed) this.deps.announce();
	}

	async published(id: string, at: number): Promise<void> {
		await this.edit((links) =>
			links.some((record) => record.id === id)
				? links.map((record) =>
						record.id === id ? { ...record, publishedAt: at } : record,
					)
				: null,
		);
	}

	/** A renamed note, or the folder holding it, keeps its links. */
	async move(from: string, to: string): Promise<void> {
		await this.edit((links) => renamedLinks(links, from, to));
	}

	/** A deleted note no longer feeds its links: a new note at that path must not inherit them. */
	async detach(path: string): Promise<void> {
		await this.edit((links) => detachedLinks(links, path));
	}

	/** Trades the links with the vault storage; true when it wrote or deleted something there. */
	async sync(storage: StorageAdapter, key: EncryptionKey): Promise<boolean> {
		if (this.pending) return false;
		this.pending = [];
		try {
			const traded = await tradeLinks(storage, key, this.deps.settings().links);
			const links = this.pending.reduce(
				(settled, change) => change(settled) ?? settled,
				traded.links,
			);
			if (
				JSON.stringify(links) !== JSON.stringify(this.deps.settings().links)
			) {
				await this.write(links);
			}
			return traded.changed;
		} finally {
			this.pending = null;
		}
	}

	/** Also told when a link expires: what is shared changes then without a write. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.armExpiry();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.disarmExpiry();
		};
	}

	/**
	 * Every record `change` replaced becomes a revision by this device, also when replayed onto a trade's
	 * outcome, so it lands above whatever the trade took in. Replayed even when it changed nothing here: it may
	 * touch a link the trade brings in. False when nothing changed.
	 */
	private async edit(change: Edit): Promise<boolean> {
		const revised: Edit = (links) => {
			const next = change(links);
			if (!next) return null;
			const kept = new Set(links);
			const ids = new Set(links.map(({ id }) => id));
			const author = this.deps.author();
			return next.map((record) =>
				kept.has(record) || !ids.has(record.id)
					? record
					: { ...record, rev: record.rev + 1, author },
			);
		};
		this.pending?.push(revised);
		const links = revised(this.deps.settings().links);
		if (!links) return false;
		await this.write(links);
		return true;
	}

	private async write(links: StoredLink[]): Promise<void> {
		this.deps.settings().links = links;
		this.notify();
		await this.deps.save();
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
		this.armExpiry();
	}

	private armExpiry(): void {
		this.disarmExpiry();
		if (this.listeners.size === 0) return;
		const now = Date.now();
		const next = Math.min(
			...this.all()
				.map(({ expires }) => (expires ?? Number.POSITIVE_INFINITY) * MS_PER_S)
				.filter((at) => at > now),
		);
		if (!Number.isFinite(next)) return;
		this.expiryTimer = window.setTimeout(
			() => this.notify(),
			Math.min(next - now, MAX_DELAY_MS),
		);
	}

	private disarmExpiry(): void {
		if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
	}
}
