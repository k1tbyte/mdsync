import * as Y from "yjs";

import { reportWarning } from "@/shared/diagnostics";

/** Edits and cursors batch this long: at 100 ms the envelope outweighed the content. */
export const FLUSH_MS = 250;
/** Silent this long, the hub dropped the last update and no later echo will tell. */
const ACK_PATIENCE_MS = 15_000;

interface OutboxIo {
	enqueue(step: () => unknown): void;
	ship(update: Uint8Array): Promise<void>;
	settle(): Promise<void>;
	online(): boolean;
}

/** What this device has to say to the room, from typed to echoed, sent in batches. */
export class Outbox {
	private readonly pending: Uint8Array[] = [];
	/** By the counter each went out under: its echo names it. */
	private readonly unacked = new Map<number, Uint8Array>();
	private sent = 0;
	/** Drawing changes held for the next batch. */
	private readonly staged = new Set<() => void>();
	private timer: number | null = null;
	private ackTimer: number | null = null;

	constructor(private readonly io: OutboxIo) {}

	get idle(): boolean {
		return (
			this.staged.size === 0 &&
			this.pending.length === 0 &&
			this.unacked.size === 0
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

	/** The counter the update goes out under. */
	addUnacked(update: Uint8Array): number {
		this.unacked.set(++this.sent, update);
		this.ackTimer ??= window.setTimeout(
			() => this.ackTimedOut(),
			ACK_PATIENCE_MS,
		);
		return this.sent;
	}

	/**
	 * The hub answers a socket's frames in order, so one sent before `n` and still
	 * unacked was dropped past its rate: returned merged, to go out again.
	 */
	ack(n: number): Uint8Array | null {
		// Merged into a resend since: that one carries it too.
		if (!this.unacked.delete(n)) return null;
		const dropped: Uint8Array[] = [];
		for (const [at, update] of this.unacked) {
			if (at > n) break;
			dropped.push(update);
			this.unacked.delete(at);
		}
		this.stopAckTimer();
		if (this.unacked.size > 0) {
			this.ackTimer = window.setTimeout(
				() => this.ackTimedOut(),
				ACK_PATIENCE_MS,
			);
		}
		return takeMerged(dropped);
	}

	takeUnacked(): Uint8Array | null {
		this.stopAckTimer();
		const merged = takeMerged([...this.unacked.values()]);
		this.unacked.clear();
		return merged;
	}

	stopTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.stopAckTimer();
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

	/** Offline it waits: going online resends everything unacked. */
	private ackTimedOut(): void {
		this.ackTimer = null;
		this.io.enqueue(() => {
			if (!this.io.online()) return;
			const all = this.takeUnacked();
			return all ? this.io.ship(all) : undefined;
		});
	}

	private stopAckTimer(): void {
		if (this.ackTimer !== null) window.clearTimeout(this.ackTimer);
		this.ackTimer = null;
	}
}

function takeMerged(updates: Uint8Array[]): Uint8Array | null {
	if (updates.length === 0) return null;
	const merged = Y.mergeUpdates(updates);
	updates.length = 0;
	return merged;
}
