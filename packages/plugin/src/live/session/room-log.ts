import type { EFrame, ServerFrame } from "@obsync/protocol";

export type StateFrame = Extract<ServerFrame, { type: typeof EFrame.State }>;

/** Deltas a room piles up before its leader folds them into a snapshot (~16 KB into ~1 KB). */
export const COMPACT_AFTER = 200;

/** How far into the room's log this device holds, and which log that is. */
export class RoomLog {
	seq = 0;
	/** The seq the room's snapshot covers, as far as this device knows. */
	private compacted = 0;
	/** Set by the first State that names it. */
	private name: string | null = null;
	/** The lost log this socket asked to move on from. */
	private left: { upto: number; log: string } | null = null;

	constructor(private readonly knownSeq = 0) {}

	/** A log other than the one this device knew: the hub lost it, and it may have grown again since. */
	lost({ head, log }: StateFrame): boolean {
		if (log !== "" && this.name !== null && log !== this.name) return true;
		return head < Math.max(this.seq, this.knownSeq);
	}

	get leaving(): boolean {
		return this.left !== null;
	}

	/** Asked again on a log still unchanged: the successor has one, so the note continued there. */
	askedAgain({ head, log }: StateFrame): boolean {
		return this.left?.upto === head && this.left.log === log;
	}

	leave({ head, log }: StateFrame): void {
		this.left = { upto: head, log };
	}

	/** A request lost with its socket is no answer: the next State asks again. */
	forgetLeaving(): void {
		this.left = null;
	}

	reached({ head, log, snapshot, deltas }: StateFrame): void {
		if (log !== "") this.name = log;
		// From 0 or from a snapshot, the deltas are everything the snapshot does not cover.
		if (snapshot || this.seq === 0) this.compacted = head - deltas.length;
		this.seq = head;
	}

	get compactionDue(): boolean {
		return this.seq - this.compacted >= COMPACT_AFTER;
	}

	compactedNow(): number {
		this.compacted = this.seq;
		return this.seq;
	}
}
