import { type LinkRecord, renamedLinks } from "./record";

const MS_PER_S = 1000;
/** setTimeout's ceiling; a later expiry just takes another lap. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The one owner of this device's share links: each change is saved and told to the subscribers. */
export class SharedLinks {
	private readonly listeners = new Set<() => void>();
	private expiryTimer: number | null = null;

	constructor(
		/** Asked each time: a settings import replaces the object. */
		private readonly settings: () => { links: LinkRecord[] },
		private readonly save: () => Promise<void>,
	) {}

	all(): readonly LinkRecord[] {
		return this.settings().links;
	}

	of(path: string): LinkRecord[] {
		return this.all().filter((record) => record.path === path);
	}

	add(record: LinkRecord): Promise<void> {
		return this.write([...this.all(), record]);
	}

	remove(id: string): Promise<void> {
		return this.write(this.all().filter((record) => record.id !== id));
	}

	published(id: string, at: number): Promise<void> {
		return this.write(
			this.all().map((record) =>
				record.id === id ? { ...record, publishedAt: at } : record,
			),
		);
	}

	/** A renamed note, or the folder holding it, keeps its links. */
	async move(from: string, to: string): Promise<void> {
		const links = renamedLinks(this.all(), from, to);
		if (links) await this.write(links);
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

	private async write(links: LinkRecord[]): Promise<void> {
		this.settings().links = links;
		this.notify();
		await this.save();
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
