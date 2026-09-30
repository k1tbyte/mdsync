import * as Y from "yjs";

import { reportWarning } from "@/shared/diagnostics";

/** Edits and cursors batch this long: at 100 ms the envelope outweighed the content. */
export const FLUSH_MS = 250;

interface OutboxIo {
	enqueue(step: () => unknown): void;
	ship(update: Uint8Array): Promise<void>;
	settle(): Promise<void>;
}

/** What this device has to say to the room, from typed to echoed, sent in batches. */
export class Outbox {
	private readonly pending: Uint8Array[] = [];
	private readonly unacked: Uint8Array[] = [];
	/** Drawing changes held for the next batch. */
	private readonly staged = new Set<() => void>();
	private timer: number | null = null;

	constructor(private readonly io: OutboxIo) {}

	get idle(): boolean {
		return (
			this.staged.size === 0 &&
			this.pending.length === 0 &&
			this.unacked.length === 0
		);
	}

	addPending(update: Uint8Array): void {
		this.pending.push(update);
		this.armFlush();
	}

	stage(drain: () => void): void {
		this.staged.add(drain);
		this.armFlush();
	}

	/** Each drain once; one that throws leaves the rest to run. */
	drainStaged(): void {
		for (const drain of [...this.staged]) {
			this.staged.delete(drain);
			try {
				drain();
			} catch (err) {
				reportWarning("A live document fell out of step.", err);
			}
		}
	}

	takePending(): Uint8Array | null {
		return takeMerged(this.pending);
	}

	addUnacked(update: Uint8Array): void {
		this.unacked.push(update);
	}

	ack(): void {
		this.unacked.shift();
	}

	takeUnacked(): Uint8Array | null {
		return takeMerged(this.unacked);
	}

	stopTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
	}

	private armFlush(): void {
		this.timer ??= window.setTimeout(() => this.flush(), FLUSH_MS);
	}

	private flush(): void {
		this.drainStaged();
		this.timer = null;
		if (this.staged.size > 0) this.armFlush();
		// Taken inside the step: taken early, an echo queued before it would
		// see nothing pending and agree on text the room does not have yet.
		this.io.enqueue(() => {
			const merged = this.takePending();
			return merged ? this.io.ship(merged) : this.io.settle();
		});
	}
}

function takeMerged(updates: Uint8Array[]): Uint8Array | null {
	if (updates.length === 0) return null;
	const merged = Y.mergeUpdates(updates);
	updates.length = 0;
	return merged;
}
