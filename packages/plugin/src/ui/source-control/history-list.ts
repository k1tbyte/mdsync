import { OFFLINE_MESSAGE, userMessage } from "@/shared";

/** A list read from history: one load at a time, and one started before `clear` never lands. */
export class HistoryList<T> {
	value: T | null = null;
	error: string | null = null;
	private loading = false;
	private generation = 0;

	constructor(private readonly onSettled: () => void) {}

	/** It failed for want of a connection, so a later answer from the storage makes it worth loading again. */
	get offline(): boolean {
		return this.error === OFFLINE_MESSAGE;
	}

	clear(): void {
		this.value = null;
		this.error = null;
		this.loading = false;
		this.generation++;
	}

	/** Loads into state, never into a captured node: a re-render discards that node. */
	load(fetch: () => Promise<T>): void {
		if (this.loading) return;
		this.loading = true;
		const generation = this.generation;
		fetch()
			.then((value) => {
				if (generation === this.generation) this.value = value;
			})
			.catch((err: unknown) => {
				if (generation === this.generation) this.error = userMessage(err);
			})
			.finally(() => {
				// A newer load owns the flag now, so leave it to that one.
				if (generation !== this.generation) return;
				this.loading = false;
				this.onSettled();
			});
	}
}
