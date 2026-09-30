import { reportWarning } from "@/shared/diagnostics";

/** Drawing changes held for the next batch, drained into the room at once. */
export class Staging {
	private readonly drains = new Set<() => void>();

	get empty(): boolean {
		return this.drains.size === 0;
	}

	add(drain: () => void): void {
		this.drains.add(drain);
	}

	/** Each drain once; one that throws leaves the rest to run. */
	drain(): void {
		for (const drain of [...this.drains]) {
			this.drains.delete(drain);
			try {
				drain();
			} catch (err) {
				reportWarning("A live document fell out of step.", err);
			}
		}
	}
}
