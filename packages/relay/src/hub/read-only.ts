/**
 * What a read-only grant may send besides following: it never pushes, so it
 * never signals (a signal wakes every device of the channel into a sync), and
 * its presence and cursors run under a ceiling.
 */

import { type ClientFrame, EFrame } from "@obsync/protocol";

/** Cursors batch every 250 ms; this passes them and cuts a flood to a trickle. */
const AWARENESS_PER_SECOND = 5;
const AWARENESS_BURST = 20;
/** An announcement is about 1 KB sealed, a cursor less. */
const MAX_AWARENESS_BYTES = 4 * 1024;

interface Bucket {
	tokens: number;
	at: number;
}

export class ReadOnlyLimits {
	private readonly buckets = new Map<number, Bucket>();

	/** Writes pass: the document handlers refuse them with a reason. */
	allows(
		tag: number,
		frame: ClientFrame,
		size: number,
		now = Date.now(),
	): boolean {
		if (frame.type === EFrame.Signal) return false;
		if (frame.type !== EFrame.Awareness) return true;
		if (size > MAX_AWARENESS_BYTES) return false;
		const last = this.buckets.get(tag) ?? { tokens: AWARENESS_BURST, at: now };
		const refilled = ((now - last.at) / 1000) * AWARENESS_PER_SECOND;
		const tokens = Math.min(AWARENESS_BURST, last.tokens + refilled);
		if (tokens < 1) return false;
		this.buckets.set(tag, { tokens: tokens - 1, at: now });
		return true;
	}

	forget(tag: number): void {
		this.buckets.delete(tag);
	}
}
