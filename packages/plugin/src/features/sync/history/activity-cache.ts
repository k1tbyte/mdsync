import type { LocalStore } from "../types";
import type { Activity } from "./model/types";

export interface CachedActivity {
	activity: Activity;
	/** When the read it came from began. */
	at: number;
}

interface Entry extends CachedActivity {
	/** Null once forgotten. */
	storage: string | null;
}

/** The vault's activity as last read from history, so the settings overview draws it without the network. */
export class ActivityCache {
	constructor(private readonly store: LocalStore) {}

	/** Null for another storage target: it holds another vault. */
	recall(storage: string): CachedActivity | null {
		const entry = this.store.load();
		if (!isEntry(entry) || entry.storage !== storage) return null;
		return { activity: entry.activity, at: entry.at };
	}

	/** A read begun before the kept one or a `forget` is stale: it may predate a push or a reset. */
	remember(storage: string, activity: Activity, since: number): void {
		const kept = this.store.load();
		if (isEntry(kept) && kept.at > since) return;
		this.store.save({ storage, activity, at: since } satisfies Entry);
	}

	/** After the remote's history went: a reset or another vault adopted at the same target. */
	forget(): void {
		this.store.save({
			storage: null,
			activity: {},
			at: Date.now(),
		} satisfies Entry);
	}
}

function isEntry(value: unknown): value is Entry {
	if (typeof value !== "object" || value === null) return false;
	const { storage, at, activity } = value as Partial<Entry>;
	return (
		(typeof storage === "string" || storage === null) &&
		typeof at === "number" &&
		typeof activity === "object" &&
		activity !== null
	);
}
