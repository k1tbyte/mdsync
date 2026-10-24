import { errorMessage } from "@/shared";

/** A list read from history: one load at a time, and one started before `clear` never lands. */
export class HistoryList<T> {
	value: T | null = null;
	error: string | null = null;
	private loading = false;
	private generation = 0;

	constructor(private readonly onSettled: () => void) {}

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
				if (generation === this.generation) this.error = errorMessage(err);
			})
			.finally(() => {
				// A newer load owns the flag now, so leave it to that one.
				if (generation !== this.generation) return;
				this.loading = false;
				this.onSettled();
			});
	}
}
