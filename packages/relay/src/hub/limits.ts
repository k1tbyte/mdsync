/**
 * Per-socket ceilings; the burst covers an update and a cursor for each of the 64 followed documents.
 * A read-only grant never signals (it wakes every device into a sync) and gets tighter presence.
 */

import { type ClientFrame, EFrame } from "@mdsync/protocol";

interface Rate {
	perSecond: number;
	burst: number;
}

const FRAMES: Rate = { perSecond: 32, burst: 256 };
const READ_ONLY_AWARENESS: Rate = { perSecond: 20, burst: 40 };
/** An announcement is about 1 KB sealed, a cursor less. */
const MAX_READ_ONLY_AWARENESS_BYTES = 4 * 1024;

interface Bucket {
	tokens: number;
	at: number;
}

export class FrameLimits {
	private readonly frames = new Map<number, Bucket>();
	private readonly awareness = new Map<number, Bucket>();

	/** Writes from a read-only grant pass: the document handlers refuse them with a reason. */
	allows(
		tag: number,
		frame: ClientFrame,
		readOnly: boolean,
		size: number,
		now = Date.now(),
	): boolean {
		if (!take(this.frames, tag, FRAMES, now)) return false;
		if (!readOnly) return true;
		if (frame.type === EFrame.Signal) return false;
		if (frame.type !== EFrame.Awareness) return true;
		return (
			size <= MAX_READ_ONLY_AWARENESS_BYTES &&
			take(this.awareness, tag, READ_ONLY_AWARENESS, now)
		);
	}

	forget(tag: number): void {
		this.frames.delete(tag);
		this.awareness.delete(tag);
	}
}

function take(
	buckets: Map<number, Bucket>,
	tag: number,
	{ perSecond, burst }: Rate,
	now: number,
): boolean {
	const last = buckets.get(tag) ?? { tokens: burst, at: now };
	const refilled = ((now - last.at) / 1000) * perSecond;
	const tokens = Math.min(burst, last.tokens + refilled);
	if (tokens < 1) return false;
	buckets.set(tag, { tokens: tokens - 1, at: now });
	return true;
}
