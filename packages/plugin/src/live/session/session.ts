/**
 * One live document: a Y.Doc kept in step with its room on the hub. Everything
 * runs through one queue, because sealing is asynchronous and the hub's echo
 * acks updates in the order they were sent.
 */

import {
	EFrame,
	ERefusal,
	MAX_FRAME_BYTES,
	type Refusal,
	type ServerFrame,
} from "@obsync/protocol";
import * as Y from "yjs";
import { type SealedFor, seal, unseal } from "@/crypto/seal";
import type { SpaceFrame, SpaceListener } from "@/hub";
import { attribute } from "@/live/authors";
import type { LiveModel } from "@/live/model";
import { reportWarning } from "@/shared/diagnostics";
import { closingUntil } from "./closing";
import { Outbox } from "./outbox";
import { RoomAwareness } from "./room-awareness";
import { RoomLog, type StateFrame } from "./room-log";
import { RoomRotation } from "./rotation";
import type { LiveSessionDeps, Rotation } from "./session-deps";

/** A payload past this cannot fit a frame with its header: the hub would drop it. */
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 1024;
const NO_NOTE = new Uint8Array();
/** Marks what came off the wire, so it is never sent back. */
const REMOTE = Symbol("remote");

export type Unaddressed<F = SpaceFrame> = F extends SpaceFrame
	? Omit<F, "doc">
	: never;

export class LiveSession<M extends LiveModel = LiveModel>
	implements SpaceListener
{
	readonly doc = new Y.Doc();
	readonly model: M;
	/** Resolves once the room answered and the disk is folded in; bind nothing before. */
	readonly ready: Promise<void>;

	private markReady!: () => void;
	private hasJoined = false;
	/** The disk read the open merged in, so `adopt` can tell what changed since. */
	protected reconciledFrom: string | null = null;
	/** Updates may go out on this socket: from its first State until it drops. */
	private online = false;
	/** Bumped per socket, so nothing queued for a dead one acts on the next. */
	private epoch = 0;
	private lastSubAt = 0;
	private disposed = false;
	private attributedAs: number | null = null;
	/** Disk text offered to an empty room, applied here only once the hub takes it. */
	private seed: Uint8Array | null = null;
	private moved: { target: string; note: Uint8Array } | null = null;
	private queue: Promise<void> = Promise.resolve();
	private readonly log: RoomLog;
	private readonly presence: RoomAwareness;
	private readonly outbox: Outbox;
	private readonly rotation: RoomRotation;
	private readonly unlisten: () => void;
	private readonly sealedFor: SealedFor;

	constructor(
		readonly docId: string,
		readonly generation: number,
		protected readonly deps: LiveSessionDeps<M>,
	) {
		this.model = deps.kind.model(this.doc);
		this.sealedFor = `doc:${docId}`;
		this.log = new RoomLog(deps.knownSeq);
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		this.outbox = new Outbox({
			enqueue: (step) => this.enqueue(step),
			ship: (update) => this.sendUpdate(update),
			settle: () => this.settle(),
		});
		this.presence = new RoomAwareness(this.doc, {
			keys: deps.keys,
			docId,
			canSend: () => this.online,
			send: (payload) => this.send({ type: EFrame.Awareness, payload }),
			enqueue: (step) => this.enqueue(step),
		});
		this.rotation = new RoomRotation({
			keys: deps.keys,
			enqueue: (step) => this.enqueue(step),
			ready: () => this.settled && this.online,
			online: () => this.online,
			seq: () => this.log.seq,
			rebuild: () => this.model.rebuild(),
			send: (frame) => this.send(frame),
		});
		this.doc.on("update", this.onLocalUpdate);
		this.unlisten = deps.hub.listen(this);
		if (deps.hub.isConnected()) this.subscribe();
	}

	get awareness() {
		return this.presence.awareness;
	}

	/** The wait for an answer counts from when the room last asked the hub for its state. */
	get subscribedAt(): number {
		return this.lastSubAt;
	}

	/** The room answered and this file is folded in: a pointer met later is where the note went. */
	get joined(): boolean {
		return this.hasJoined;
	}

	/** Joined and not moved: a moved room takes nothing more, its successor does. */
	get synced(): boolean {
		return this.hasJoined && this.moved === null;
	}

	/** The room holds every edit made here: nothing staged, pending or unacked. */
	get settled(): boolean {
		return this.synced && !this.disposed && this.outbox.idle;
	}

	/** The last room seq applied here. */
	get seq(): number {
		return this.log.seq;
	}

	/** Where the room continued once another device rebuilt it. */
	get movedTo(): string | null {
		return this.moved?.target ?? null;
	}

	/** Sealed by whoever moved the room with its file; empty for a plain rotation. */
	get moveNote(): Uint8Array | null {
		return this.moved?.note ?? null;
	}

	nameOf(person: string): string | null {
		return this.deps.nameOf?.(person) ?? null;
	}

	/** Folds in a version edited outside the room, three-way against the one it grew from; false when it cannot. */
	absorb(base: string, incoming: string): boolean {
		this.drainStaged();
		this.model.merge(base, incoming);
		return true;
	}

	stage(drain: () => void): void {
		if (!this.disposed) this.outbox.stage(drain);
	}

	drainStaged(): void {
		this.outbox.drainStaged();
	}

	/** Folds in what the first bound view gained since the disk read the open merged. */
	adopt(current: string): void {
		const from = this.reconciledFrom;
		// A later view may lag the room; merged against this old read it would duplicate.
		this.reconciledFrom = null;
		if (from === null || current === from) return;
		this.model.merge(from, current);
	}

	/** Rebuilds the document into `target` and moves the room there, unless the log moved on meanwhile. */
	rotate(target: string, note: Uint8Array = NO_NOTE): Promise<Rotation> {
		return this.rotation.ask(target, note);
	}

	onConnectionChange(connected: boolean): void {
		if (this.disposed) return;
		this.rotation.end("busy");
		this.epoch++;
		this.online = false;
		this.log.forgetLeaving();
		if (connected) this.subscribe();
		else this.enqueue(() => this.presence.dropAll());
	}

	onFrame(frame: ServerFrame): void {
		if (this.disposed || frame.doc !== this.docId) return;
		const epoch = this.epoch;
		this.enqueue(() => epoch === this.epoch && this.handle(frame, epoch));
	}

	/** Unacked edits may never reach the room, but they are on disk: the next open merges them back. */
	dispose(): void {
		if (this.disposed) return;
		this.drainStaged();
		this.disposed = true;
		this.rotation.end("busy");
		this.unlisten();
		this.outbox.stopTimer();
		this.presence.stopTimer();
		const rest = this.outbox.takePending();
		this.enqueue(async () => {
			if (rest) await this.sendUpdate(rest);
			this.send({ type: EFrame.Unsub });
			this.doc.off("update", this.onLocalUpdate);
			this.model.dispose();
			this.presence.dispose();
			this.doc.destroy();
		});
		closingUntil(this.docId, this.queue);
	}

	protected send(frame: Unaddressed): void {
		if ("payload" in frame && frame.payload.length > MAX_PAYLOAD_BYTES) {
			this.onRefused(ERefusal.TooLarge);
			return;
		}
		this.deps.hub.send({ ...frame, doc: this.docId } as SpaceFrame);
	}

	protected local(update: Uint8Array): void {
		this.outbox.addPending(update);
		// Per client id, not once: Yjs renews it when another client uses the same.
		if (this.attributedAs === this.doc.clientID) return;
		this.attributedAs = this.doc.clientID;
		attribute(this.doc, this.deps.author);
	}

	protected async offerSeed(epoch: number): Promise<void> {
		const disk = await this.deps.readDisk();
		const seed = this.deps.kind.seed(disk);
		const payload = await seal(this.deps.keys, seed, this.sealedFor);
		// An echo on a later socket must not be taken for this seed's.
		if (epoch !== this.epoch) return;
		this.seed = seed;
		this.reconciledFrom = disk;
		this.send({ type: EFrame.Seed, payload });
	}

	/**
	 * Replays this device's own changes since the base onto the room: diffing the
	 * room straight to the disk would turn an overwrite into deletions of what
	 * others wrote meanwhile.
	 */
	protected async reconcile(): Promise<boolean> {
		// Base first: a file sync writes the disk before the base, so the pair read is never base-ahead.
		const base = await this.deps.readBase();
		const disk = await this.deps.readDisk();
		this.reconciledFrom = disk;
		this.model.merge(base, disk);
		return true;
	}

	/**
	 * Rebuilds a room that lost its log as its next generation. Refilled in
	 * place, its seq would restart under marks ordered by it, and a log grown
	 * again from another device's disk would double the text applied here.
	 */
	protected async moveOn(frame: StateFrame, epoch: number): Promise<void> {
		this.online = false;
		const target = await this.deps.successor();
		if (this.log.askedAgain(frame)) return this.onMoved(target, NO_NOTE);
		this.drainStaged();
		const content = this.hasJoined
			? this.model.rebuild()
			: this.deps.kind.seed(await this.deps.readDisk());
		const payload = await seal(this.deps.keys, content, `doc:${target}`);
		if (epoch !== this.epoch) return;
		this.log.leave(frame);
		const upto = frame.head;
		this.send({ type: EFrame.Rotate, target, upto, note: NO_NOTE, payload });
	}

	private handle(frame: ServerFrame, epoch: number): Promise<void> | void {
		switch (frame.type) {
			case EFrame.State:
				return this.onState(frame, epoch);
			case EFrame.Fanout:
				return this.onFanout(frame.seq, frame.payload);
			case EFrame.Echo:
				return this.onEcho(frame.seq);
			case EFrame.Peer:
				return this.presence.receive(frame.payload, frame.from);
			case EFrame.Join:
				return this.presence.announce();
			case EFrame.Leave:
				return this.presence.depart(frame.from);
			case EFrame.Moved:
				return this.onMoved(frame.target, frame.note);
			case EFrame.Refused:
				return this.onRefused(frame.reason);
		}
	}

	private subscribe(): void {
		this.lastSubAt = Date.now();
		this.send({ type: EFrame.Sub, since: this.log.seq });
	}

	private async onState(frame: StateFrame, epoch: number): Promise<void> {
		if (this.log.lost(frame)) return this.moveOn(frame, epoch);
		if (frame.snapshot) await this.apply(frame.snapshot);
		for (const delta of frame.deltas) await this.apply(delta);
		this.log.reached(frame);

		if (!this.hasJoined && !(await this.join(frame.head, epoch))) return;
		// On a socket already online a State only answers a refused rotation: nothing to resend.
		if (this.online) this.rotation.end("refused");
		else if (epoch === this.epoch) await this.goOnline();
		await this.settle();
	}

	/** False while the join is still out: a seed offered, or a disk a reader cannot follow. */
	private async join(head: number, epoch: number): Promise<boolean> {
		// Only a room with no history is seeded: an empty one with a log is a
		// deleted note, and one this device knew had a log lost it.
		if (head === 0) {
			await this.offerSeed(epoch);
			return false;
		}
		this.seed = null;
		if (!(await this.reconcile())) return false;
		this.markJoined();
		return true;
	}

	private markJoined(): void {
		this.hasJoined = true;
		this.markReady();
	}

	/** Whatever an earlier socket left unacked goes out again, as one update. */
	private async goOnline(): Promise<void> {
		this.online = true;
		const resend = this.outbox.takeUnacked();
		if (resend) await this.sendUpdate(resend);
		await this.presence.announce();
	}

	private async onFanout(seq: number, payload: Uint8Array): Promise<void> {
		// A pending seed is answered by its echo or by the whole room, so these add nothing;
		// a lost log's are another history.
		if (!this.hasJoined || this.log.leaving) return;
		this.log.seq = seq;
		await this.apply(payload);
		await this.settle();
	}

	private async onEcho(seq: number): Promise<void> {
		this.log.seq = seq;
		if (this.hasJoined) {
			this.outbox.ack();
		} else if (this.seed) {
			Y.applyUpdate(this.doc, this.seed, REMOTE);
			this.seed = null;
			this.markJoined();
			await this.goOnline();
		}
		await this.settle();
	}

	/** With nothing local outstanding the doc is exactly the room at `seq`: agreed, and a snapshot can replace the log. */
	private async settle(): Promise<void> {
		if (!this.settled) return;
		this.deps.onAgreed(this.model.agreed(), this.log.seq);
		if (!this.log.compactionDue || !this.presence.leads()) return;
		const upto = this.log.compactedNow();
		const payload = await seal(
			this.deps.keys,
			Y.encodeStateAsUpdate(this.doc),
			this.sealedFor,
		);
		if (this.online) {
			this.send({ type: EFrame.Snapshot, upto, payload });
		}
	}

	private onMoved(target: string, note: Uint8Array): void {
		this.moved = { target, note };
		this.rotation.end("moved");
		this.deps.onMoved();
	}

	private onRefused(reason: Refusal): void {
		this.online = false;
		this.rotation.end("refused");
		this.deps.onRefused(reason);
	}

	private async apply(payload: Uint8Array): Promise<void> {
		const update = await unseal(this.deps.keys, payload, this.sealedFor);
		if (update) Y.applyUpdate(this.doc, update, REMOTE);
	}

	/** Unacked before sealing: an edit is always pending or unacked until its echo. */
	private async sendUpdate(update: Uint8Array): Promise<void> {
		this.outbox.addUnacked(update);
		const payload = await seal(this.deps.keys, update, this.sealedFor);
		if (this.online) this.send({ type: EFrame.Update, payload });
	}

	private enqueue(step: () => unknown): void {
		this.queue = this.queue.then(step).then(
			() => undefined,
			(err) => reportWarning("A live document fell out of step.", err),
		);
	}

	private readonly onLocalUpdate = (
		update: Uint8Array,
		origin: unknown,
	): void => {
		if (origin === REMOTE || this.disposed) return;
		this.local(update);
	};
}
