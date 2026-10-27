export interface UnseenStore {
	load(): unknown;
	save(paths: string[]): void;
}

/** Files others changed that this device has not opened since: the tree's "new" dot. */
export class Unseen {
	private readonly paths: Set<string>;
	private readonly listeners = new Set<() => void>();

	constructor(private readonly store: UnseenStore) {
		const saved = store.load();
		this.paths = new Set(
			Array.isArray(saved)
				? saved.filter((path): path is string => typeof path === "string")
				: [],
		);
	}

	all(): ReadonlySet<string> {
		return this.paths;
	}

	add(paths: Iterable<string>): void {
		const fresh = [...paths].filter((path) => !this.paths.has(path));
		for (const path of fresh) this.paths.add(path);
		if (fresh.length > 0) this.changed();
	}

	/** Opened or deleted, the path and whatever was under it. */
	drop(path: string): void {
		const gone = this.under(path);
		for (const each of gone) this.paths.delete(each);
		if (gone.length > 0) this.changed();
	}

	move(from: string, to: string): void {
		const moved = this.under(from);
		for (const each of moved) {
			this.paths.delete(each);
			this.paths.add(to + each.slice(from.length));
		}
		if (moved.length > 0) this.changed();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private under(path: string): string[] {
		return [...this.paths].filter(
			(each) => each === path || each.startsWith(`${path}/`),
		);
	}

	private changed(): void {
		this.store.save([...this.paths]);
		for (const listener of this.listeners) listener();
	}
}
