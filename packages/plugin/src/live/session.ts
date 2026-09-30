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

import type { SpaceFrame, SpaceListener } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";

import { USERS } from "./authors";
import { closingUntil } from "./closing";
import type { LiveModel } from "./model";
import { RoomAwareness } from "./room-awareness";
import { type SealedFor, seal, unseal } from "./seal";
import type { LiveSessionDeps, Rotation } from "./session-deps";
import { Staging } from "./staging";

/** Edits and cursors batch this long: at 100 ms the envelope outweighed the content. */
const FLUSH_MS = 250;
/** Deltas a room piles up before its leader folds them into a snapshot (~16 KB into ~1 KB). */
export const COMPACT_AFTER = 200;
/** Marks what came off the wire, so it is never sent back. */
const REMOTE = Symbol("remote");
/** A payload past this cannot fit a frame with its header: the hub would drop it. */
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - 1024;
/** A plain rotation: the note keeps its path. */
const NO_NOTE = new Uint8Array();

type Frame<T> = Extract<ServerFrame, { type: T }>;
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
	private inSync = false;
	/** The disk read the open merged in, so `adopt` can tell what changed since. */
	protected reconciledFrom: string | null = null;
	/** Updates may go out on this socket: from its first State until it drops. */
	private online = false;
	/** Bumped per socket, so nothing queued for a dead one acts on the next. */
	private epoch = 0;
	private lastSubAt = 0;
	private disposed = false;
	private lastSeq = 0;
	/** The seq the room's snapshot covers, as far as this device knows. */
	private compacted = 0;
	/** Sealed or sent, oldest first, until the hub echoes each. */
	private unacked: Uint8Array[] = [];
	private pending: Uint8Array[] = [];
	/** Disk text offered to an empty room, applied here only once the hub takes it. */
	private seed: Uint8Array | null = null;
	private moved: { target: string; note: Uint8Array } | null = null;
	/** Names the room's log once a State did. */
	private log: string | null = null;
	/** The lost log this socket asked to move on from. */
	private lost: { upto: number; log: string } | null = null;
	/** Settles the rotation this device asked the hub for. */
	private rotation: ((outcome: Rotation) => void) | null = null;
	private attributed = false;
	private readonly presence: RoomAwareness;
	private queue: Promise<void> = Promise.resolve();
	private updateTimer: number | null = null;
	private readonly staged = new Staging();
	private readonly unlisten: () => void;
	private readonly sealedFor: SealedFor;

	private readonly handlers: {
		[K in ServerFrame["type"]]?: (frame: Frame<K>, epoch: number) => unknown;
	} = {
		[EFrame.State]: (frame, epoch) => this.onState(frame, epoch),
		[EFrame.Fanout]: (frame) => this.onFanout(frame),
		[EFrame.Echo]: (frame) => this.onEcho(frame.seq),
		[EFrame.Peer]: (frame) => this.presence.receive(frame.payload, frame.from),
		[EFrame.Join]: () => this.presence.announce(),
		[EFrame.Leave]: (frame) => this.presence.depart(frame.from),
		[EFrame.Moved]: (frame) => this.onMoved(frame.target, frame.note),
		[EFrame.Refused]: (frame) => this.onRefused(frame.reason),
	};

	constructor(
		readonly docId: string,
		readonly generation: number,
		protected readonly deps: LiveSessionDeps<M>,
	) {
		this.model = deps.kind.model(this.doc);
		this.sealedFor = `doc:${docId}`;
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		this.presence = new RoomAwareness(this.doc, {
			keys: deps.keys,
			docId,
			canSend: () => this.online,
			send: (payload) => this.send({ type: EFrame.Awareness, payload }),
			enqueue: (step) => this.enqueue(step),
		});
		this.doc.on("update", this.onLocalUpdate);
		this.unlisten = deps.hub.listen(this);
		if (deps.hub.isConnected()) this.subscribe();
	}

	get awareness() {
		return this.presence.awareness;
	}

	/** When the room last asked the hub for its state: the wait for an answer counts from here. */
	get subscribedAt(): number {
		return this.lastSubAt;
	}

	/** A moved room takes nothing more: its successor does. */
	get synced(): boolean {
		return this.inSync && this.moved === null;
	}

	/** The name the relay vouches for a person present in the room's space. */
	nameOf(person: string): string | null {
		return this.deps.nameOf?.(person) ?? null;
	}

	/** The docId this room continued as, once another device rebuilt it. */
	get movedTo(): string | null {
		return this.moved?.target ?? null;
	}

	/** Sealed by whoever moved the room with its file; empty for a plain rotation. */
	get moveNote(): Uint8Array | null {
		return this.moved?.note ?? null;
	}

	/** The room answered and holds this file: a pointer met later is where this note went. */
	get joined(): boolean {
		return this.inSync;
	}

	/** The room holds every edit made here: nothing staged, pending or unacked. */
	get settled(): boolean {
		return (
			this.synced &&
			!this.disposed &&
			this.staged.empty &&
			this.unacked.length === 0 &&
			this.pending.length === 0
		);
	}

	/** The last room seq this document holds. */
	get seq(): number {
		return this.lastSeq;
	}

	/** Folds in a version edited outside the room, three-way against the one it grew from; false when it cannot. */
	absorb(base: string, incoming: string): boolean {
		this.drainStaged();
		this.model.merge(base, incoming);
		return true;
	}

	stage(drain: () => void): void {
		if (this.disposed) return;
		this.staged.add(drain);
		this.armFlush();
	}

	drainStaged(): void {
		this.staged.drain();
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
		return new Promise((resolve) =>
			this.enqueue(async () => {
				if (!this.settled || !this.online || this.rotation) {
					return resolve("busy");
				}
				const upto = this.lastSeq;
				const payload = await seal(
					this.deps.keys,
					this.model.rebuild(),
					`doc:${target}`,
				);
				if (!this.online) return resolve("busy");
				this.rotation = resolve;
				this.send({ type: EFrame.Rotate, target, upto, note, payload });
			}),
		);
	}

	onConnectionChange(connected: boolean): void {
		if (this.disposed) return;
		this.endRotation("busy");
		this.epoch++;
		this.online = false;
		// A request lost with its socket is no answer: the next State asks again.
		this.lost = null;
		if (connected) this.subscribe();
		else this.enqueue(() => this.presence.dropAll());
	}

	onFrame(frame: ServerFrame): void {
		if (this.disposed) return;
		if (frame.doc !== this.docId) return;
		const epoch = this.epoch;
		const handler = this.handlers[frame.type] as
			| ((frame: ServerFrame, epoch: number) => unknown)
			| undefined;
		if (!handler) return;
		this.enqueue(() => epoch === this.epoch && handler(frame, epoch));
	}

	/** Unacked edits may never reach the room, but they are on disk: the next open merges them back. */
	dispose(): void {
		if (this.disposed) return;
		this.drainStaged();
		this.disposed = true;
		this.endRotation("busy");
		this.unlisten();
		if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
		this.presence.stopTimer();
		const rest = this.takePending();
		this.enqueue(async () => {
			if (rest) await this.sendUpdate(rest);
			this.send({ type: EFrame.Unsub });
			this.doc.off("update", this.onLocalUpdate);
			this.model.dispose();
			this.presence.dispose();
			this.doc.destroy();
		});
		// The queue settles even on errors, so a reopen never waits forever.
		closingUntil(this.docId, this.queue);
	}

	private subscribe(): void {
		this.lastSubAt = Date.now();
		this.send({ type: EFrame.Sub, since: this.lastSeq });
	}

	private async onState(
		frame: Frame<typeof EFrame.State>,
		epoch: number,
	): Promise<void> {
		if (this.lostLog(frame)) return this.moveOn(frame, epoch);
		if (frame.log !== "") this.log = frame.log;
		if (frame.snapshot) await this.apply(frame.snapshot);
		for (const delta of frame.deltas) await this.apply(delta);
		// From 0 or from a snapshot, the deltas are everything the snapshot does not cover.
		if (frame.snapshot || this.lastSeq === 0) {
			this.compacted = frame.head - frame.deltas.length;
		}
		this.lastSeq = frame.head;

		if (!this.inSync) {
			// Only a room with no history is seeded: an empty one with a log is a
			// deleted note, and one this device knew had a log lost it (above).
			if (frame.head === 0) return this.offerSeed(epoch);
			this.seed = null;
			if (!(await this.reconcile())) return;
			this.markSynced();
		}
		// On a socket already online a State only answers a refused rotation: nothing to resend.
		if (this.online) this.endRotation("refused");
		else if (epoch === this.epoch) await this.goOnline();
		await this.settle();
	}

	/** A log other than the one this device knew: the hub lost it, and it may have grown again since. */
	private lostLog({ head, log }: Frame<typeof EFrame.State>): boolean {
		if (log !== "" && this.log !== null && log !== this.log) return true;
		return head < Math.max(this.lastSeq, this.deps.knownSeq ?? 0);
	}

	/**
	 * Rebuilds a room that lost its log as its next generation. Refilled in
	 * place, its seq would restart under marks ordered by it; and a log grown
	 * again from another device's disk would double the text applied here.
	 */
	protected async moveOn(
		frame: Frame<typeof EFrame.State>,
		epoch: number,
	): Promise<void> {
		this.online = false;
		const target = await this.deps.successor();
		const { head: upto, log } = frame;
		if (this.lost?.upto === upto && this.lost.log === log) {
			// Refused with the log unchanged: the successor has one, so the note continued there.
			return this.onMoved(target, NO_NOTE);
		}
		this.drainStaged();
		const content = this.inSync
			? this.model.rebuild()
			: this.deps.kind.seed(await this.deps.readDisk());
		const payload = await seal(this.deps.keys, content, `doc:${target}`);
		if (epoch !== this.epoch) return;
		this.lost = { upto, log };
		this.send({ type: EFrame.Rotate, target, upto, note: NO_NOTE, payload });
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
	 * Replays this device's own changes since the base onto the room. Diffing
	 * the room straight to the disk would express an overwrite as operations and
	 * delete everything the others wrote meanwhile.
	 */
	protected async reconcile(): Promise<boolean> {
		// Base first: a file sync writes the disk before the base, so the pair read is never base-ahead.
		const base = await this.deps.readBase();
		const disk = await this.deps.readDisk();
		this.reconciledFrom = disk;
		this.model.merge(base, disk);
		return true;
	}

	private markSynced(): void {
		this.inSync = true;
		this.markReady();
	}

	/** Whatever an earlier socket left unacked goes out again, as one update. */
	private async goOnline(): Promise<void> {
		this.online = true;
		if (this.unacked.length > 0) {
			const resend = Y.mergeUpdates(this.unacked);
			this.unacked = [];
			await this.sendUpdate(resend);
		}
		await this.presence.announce();
	}

	private async onFanout(frame: Frame<typeof EFrame.Fanout>): Promise<void> {
		// A pending seed is answered by its echo or by the whole room, so these add nothing;
		// a lost log's are another history.
		if (!this.inSync || this.lost) return;
		this.lastSeq = frame.seq;
		await this.apply(frame.payload);
		await this.settle();
	}

	private async onEcho(seq: number): Promise<void> {
		this.lastSeq = seq;
		if (this.inSync) {
			this.unacked.shift();
		} else if (this.seed) {
			Y.applyUpdate(this.doc, this.seed, REMOTE);
			this.seed = null;
			this.markSynced();
			await this.goOnline();
		}
		await this.settle();
	}

	/**
	 * With nothing local outstanding the doc is exactly the room at `lastSeq`:
	 * that content is agreed, and a snapshot of it can replace the log.
	 */
	private async settle(): Promise<void> {
		if (!this.settled) return;
		this.deps.onAgreed(this.model.agreed(), this.lastSeq);
		if (
			this.lastSeq - this.compacted < COMPACT_AFTER ||
			!this.presence.leads()
		) {
			return;
		}
		this.compacted = this.lastSeq;
		const snapshot = Y.encodeStateAsUpdate(this.doc);
		const payload = await seal(this.deps.keys, snapshot, this.sealedFor);
		if (this.online) {
			this.send({ type: EFrame.Snapshot, upto: this.compacted, payload });
		}
	}

	private onMoved(target: string, note: Uint8Array): void {
		this.moved = { target, note };
		this.endRotation("moved");
		this.deps.onMoved();
	}

	private onRefused(reason: Refusal): void {
		this.online = false;
		this.endRotation("refused");
		this.deps.onRefused(reason);
	}

	private endRotation(outcome: Rotation): void {
		this.rotation?.(outcome);
		this.rotation = null;
	}

	/** The first local edit names who typed it; keyed by client, concurrent entries never collide. */
	private attribute(): void {
		if (this.attributed) return;
		this.attributed = true;
		this.doc.getMap(USERS).set(String(this.doc.clientID), this.deps.author);
	}

	private async apply(payload: Uint8Array): Promise<void> {
		const update = await unseal(this.deps.keys, payload, this.sealedFor);
		// A frame this key cannot open was sealed under another passphrase.
		if (update) Y.applyUpdate(this.doc, update, REMOTE);
	}

	/** Unacked before sealing: an edit is always pending or unacked until its echo. */
	private async sendUpdate(update: Uint8Array): Promise<void> {
		this.unacked.push(update);
		const payload = await seal(this.deps.keys, update, this.sealedFor);
		if (this.online) this.send({ type: EFrame.Update, payload });
	}

	protected send(frame: Unaddressed): void {
		if ("payload" in frame && frame.payload.length > MAX_PAYLOAD_BYTES) {
			this.onRefused(ERefusal.TooLarge);
			return;
		}
		this.deps.hub.send({ ...frame, doc: this.docId } as SpaceFrame);
	}

	private enqueue(step: () => unknown): void {
		this.queue = this.queue.then(step).then(
			() => undefined,
			(err) => reportWarning("A live document fell out of step.", err),
		);
	}

	private takePending(): Uint8Array | null {
		if (this.pending.length === 0) return null;
		const update = Y.mergeUpdates(this.pending);
		this.pending = [];
		return update;
	}

	private readonly onLocalUpdate = (
		update: Uint8Array,
		origin: unknown,
	): void => {
		if (origin === REMOTE || this.disposed) return;
		this.local(update);
	};

	protected local(update: Uint8Array): void {
		this.pending.push(update);
		this.attribute();
		this.armFlush();
	}

	private armFlush(): void {
		this.updateTimer ??= window.setTimeout(() => this.flush(), FLUSH_MS);
	}

	private flush(): void {
		this.drainStaged();
		this.updateTimer = null;
		if (!this.staged.empty) this.armFlush();
		// Taken inside the step: taken early, an echo queued before it would
		// see nothing pending and agree on text the room does not have yet.
		this.enqueue(() => {
			const merged = this.takePending();
			return merged ? this.sendUpdate(merged) : this.settle();
		});
	}
}
