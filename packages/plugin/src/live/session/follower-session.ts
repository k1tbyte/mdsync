/**
 * A read-only person's room: follows, never writes (the hub refuses it); anything that would write is left
 * to the file sync.
 */

import { EFrame } from "@mdsync/protocol";
import type { LiveModel } from "@/live/model";
import { toLf } from "@/utils";
import { FOLLOWS } from "./room-awareness";
import { LiveSession, type Unaddressed } from "./session";
import type { Follower, LiveSessionDeps, Rotation } from "./session-deps";

/** All a reader sends: following, leaving, and its own cursor. */
const READS = new Set<Unaddressed["type"]>([
	EFrame.Sub,
	EFrame.Unsub,
	EFrame.Awareness,
]);

export class FollowerSession<
	M extends LiveModel = LiveModel,
> extends LiveSession<M> {
	private readonly follower: Follower;

	constructor(
		docId: string,
		generation: number,
		deps: LiveSessionDeps<M> & { follower: Follower },
	) {
		super(docId, generation, deps);
		this.follower = deps.follower;
		this.awareness.setLocalStateField(FOLLOWS, true);
	}

	/** A reader cannot pass a version into the room: unless it is there already, the note leaves it. */
	override absorb(_base: string, incoming: string): boolean {
		if (toLf(incoming) === this.model.agreed()) return true;
		this.follower.onCold("diverged");
		return false;
	}

	override rotate(): Promise<Rotation> {
		return Promise.resolve("refused");
	}

	/** A lost log is moved on by a writer; its pointer brings the next open there. */
	protected override async moveOn(): Promise<void> {
		this.follower.onCold("empty");
	}

	protected override async offerSeed(): Promise<void> {
		this.follower.onCold("empty");
	}

	/** Joins as the room is: bound, the view shows the room's text, so a disk with changes of its own stays cold. */
	protected override async reconcile(): Promise<boolean> {
		const disk = await this.deps.readDisk();
		this.reconciledFrom = disk;
		const same =
			toLf(disk) === this.model.agreed() ||
			(await this.follower.unchanged(disk));
		if (!same) this.follower.onCold("diverged");
		return same;
	}

	/** A change made here could never reach the room: the note leaves it. */
	protected override local(): void {
		this.follower.onCold("diverged");
	}

	protected override send(frame: Unaddressed): void {
		if (READS.has(frame.type)) super.send(frame);
	}
}
