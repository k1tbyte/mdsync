/**
 * One live document: a Y.Doc kept in step with its room on the hub. Everything
 * runs through one queue, because sealing is asynchronous and the hub's echo
 * acks updates in the order they were sent.
 */

import { type ClientFrame, EFrame, type ServerFrame } from "@obsync/protocol";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

import type { LiveKeys } from "@/crypto/live-keys";
import {
	type HubConnection,
	type HubListener,
	VAULT_SLOT,
} from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";
import { toLf } from "@/utils/eol";

import { mergeThreeWay } from "./merge";
import { patchYText } from "./patch";
import { BODY, rebuild, USERS } from "./rebuild";
import { seal, unseal } from "./seal";

/** Edits and cursors batch this long: at 100 ms the envelope outweighed the content. */
const FLUSH_MS = 250;
/** Deltas a room piles up before its leader folds them into a snapshot (~16 KB into ~1 KB). */
export const COMPACT_AFTER = 200;
/** Marks what came off the wire, so it is never sent back. */
const REMOTE = Symbol("remote");
/** The origin y-protocols gives this device's own awareness changes. */
const LOCAL_AWARENESS = "local";

/** "busy": not now - edits still unacked, offline, or the answer was lost. */
export type Rotation = "moved" | "refused" | "busy";

type Frame<T> = Extract<ServerFrame, { type: T }>;
type Unaddressed<F = ClientFrame> = F extends ClientFrame
	? Omit<F, "slot" | "doc">
	: never;
interface AwarenessChanges {
	added: number[];
	updated: number[];
	removed: number[];
}

export interface LiveSessionDeps {
	keys: LiveKeys;
	hub: Pick<HubConnection, "send" | "isConnected" | "listen">;
	/** Who this device types as: attribution maps its client ids to them. */
	person: string;
	/** Opened by following a moved room, which is never seeded from disk. */
	follower?: boolean;
	readDisk(): Promise<string>;
	/** The text the disk last agreed on with everyone: the base of the merge. */
	readBase(): Promise<string>;
	/** The room now holds all of `text`: nothing local is pending or unacked. */
	onAgreed(text: string, seq: number): void;
	/** The room was rebuilt elsewhere and now points at its successor. */
	onMoved(): void;
}

export class LiveSession implements HubListener {
	readonly doc = new Y.Doc();
	readonly text = this.doc.getText(BODY);
	readonly awareness = new Awareness(this.doc);
	/** Bindings add their own origins: the merge on open is never undone by a keystroke. */
	readonly undoManager = new Y.UndoManager(this.text, {
		trackedOrigins: new Set(),
	});
	/** Resolves once the room answered and the disk is folded in; bind nothing before. */
	readonly ready: Promise<void>;

	private markReady!: () => void;
	private inSync = false;
	/** The disk text the open merged in, so `adopt` can tell what was typed since. */
	private reconciledFrom: string | null = null;
	/** Updates may go out on this socket: from its first State until it drops. */
	private online = false;
	/** Bumped per socket, so nothing queued for a dead one acts on the next. */
	private epoch = 0;
	private disposed = false;
	private lastSeq = 0;
	/** The seq the room's snapshot covers, as far as this device knows. */
	private compacted = 0;
	/** Sealed or sent, oldest first, until the hub echoes each. */
	private unacked: Uint8Array[] = [];
	private pending: Uint8Array[] = [];
	/** Disk text offered to an empty room, applied here only once the hub takes it. */
	private seed: Uint8Array | null = null;
	private moved: string | null = null;
	/** Settles the rotation this device asked the hub for. */
	private rotation: ((outcome: Rotation) => void) | null = null;
	private attributed = false;
	/** Hub socket tag -> the awareness clients it announced, so its Leave clears them. */
	private readonly peers = new Map<number, Set<number>>();
	private queue: Promise<void> = Promise.resolve();
	private updateTimer: number | null = null;
	private awarenessTimer: number | null = null;
	private readonly unlisten: () => void;

	private readonly handlers: {
		[K in ServerFrame["type"]]?: (frame: Frame<K>, epoch: number) => unknown;
	} = {
		[EFrame.State]: (frame, epoch) => this.onState(frame, epoch),
		[EFrame.Fanout]: (frame) => this.onFanout(frame),
		[EFrame.Echo]: (frame) => this.onEcho(frame.seq),
		[EFrame.Peer]: (frame) => this.onPeer(frame),
		// Awareness is never stored, so a newcomer only learns about us from this.
		[EFrame.Join]: () => this.sendAwareness(),
		[EFrame.Leave]: (frame) => this.onLeave(frame.from),
		[EFrame.Moved]: (frame) => this.onMoved(frame.target),
	};

	constructor(
		readonly docId: string,
		readonly generation: number,
		private readonly deps: LiveSessionDeps,
	) {
		this.ready = new Promise((resolve) => {
			this.markReady = resolve;
		});
		this.doc.on("update", this.onLocalUpdate);
		this.awareness.on("update", this.onAwareness);
		this.unlisten = deps.hub.listen(this);
		if (deps.hub.isConnected()) this.subscribe();
	}

	/** A moved room takes nothing more: its successor does. */
	get synced(): boolean {
		return this.inSync && this.moved === null;
	}

	/** The docId this room continued as, once another device rebuilt it. */
	get movedTo(): string | null {
		return this.moved;
	}

	/** The room holds every edit made here: nothing pending, nothing unacked. */
	get settled(): boolean {
		return (
			this.synced &&
			!this.disposed &&
			this.unacked.length === 0 &&
			this.pending.length === 0
		);
	}

	/** The last room seq this document holds. */
	get seq(): number {
		return this.lastSeq;
	}

	/** Folds in a version edited outside the room, three-way against the one it grew from. */
	absorb(base: string, incoming: string): void {
		patchYText(
			this.doc,
			this.text,
			mergeThreeWay(toLf(base), toLf(incoming), this.text.toString()),
		);
	}

	/** Folds in what the first bound editor gained since the disk read the open merged. */
	adopt(editorText: string): void {
		const typed = toLf(editorText);
		const from = this.reconciledFrom;
		// A later editor may lag the room; merged against this old read it would duplicate.
		this.reconciledFrom = null;
		if (from === null || typed === from) return;
		patchYText(
			this.doc,
			this.text,
			mergeThreeWay(from, typed, this.text.toString()),
		);
	}

	/** Rebuilds the document into `target` and moves the room there, unless the log moved on meanwhile. */
	rotate(target: string): Promise<Rotation> {
		return new Promise((resolve) =>
			this.enqueue(async () => {
				if (!this.settled || !this.online || this.rotation) {
					return resolve("busy");
				}
				const upto = this.lastSeq;
				const payload = await seal(this.deps.keys, rebuild(this.doc));
				if (!this.online) return resolve("busy");
				this.rotation = resolve;
				this.send({ type: EFrame.Rotate, target, upto, payload });
			}),
		);
	}

	onConnectionChange(connected: boolean): void {
		if (this.disposed) return;
		this.endRotation("busy");
		this.epoch++;
		this.online = false;
		if (connected) this.subscribe();
		else this.enqueue(() => this.dropPeers());
	}

	onFrame(frame: ServerFrame): void {
		if (this.disposed) return;
		if (frame.slot !== VAULT_SLOT || frame.doc !== this.docId) return;
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
		this.disposed = true;
		this.endRotation("busy");
		this.unlisten();
		this.clearTimers();
		const rest = this.takePending();
		this.enqueue(async () => {
			if (rest) await this.sendUpdate(rest);
			this.send({ type: EFrame.Unsub });
			this.doc.off("update", this.onLocalUpdate);
			this.undoManager.destroy();
			this.awareness.destroy();
			this.doc.destroy();
		});
	}

	private subscribe(): void {
		this.send({ type: EFrame.Sub, since: this.lastSeq });
	}

	private async onState(
		frame: Frame<typeof EFrame.State>,
		epoch: number,
	): Promise<void> {
		if (frame.head < this.lastSeq) {
			// The room lost its log (a redeploy, wiped storage): fetch what it has
			// now and put back everything this device holds.
			this.online = false;
			this.lastSeq = 0;
			this.unacked = [Y.encodeStateAsUpdate(this.doc)];
			this.subscribe();
			return;
		}
		if (frame.snapshot) await this.apply(frame.snapshot);
		for (const delta of frame.deltas) await this.apply(delta);
		// From 0 or from a snapshot, the deltas are everything the snapshot does not cover.
		if (frame.snapshot || this.lastSeq === 0) {
			this.compacted = frame.head - frame.deltas.length;
		}
		this.lastSeq = frame.head;

		if (!this.inSync) {
			// Only a room with no history is seeded: an empty one with a log is a
			// deleted note, and a successor is filled by whoever rebuilt it.
			if (frame.head === 0) {
				return this.deps.follower ? undefined : this.offerSeed(epoch);
			}
			this.seed = null;
			await this.reconcile();
			this.markSynced();
		}
		// On a socket already online a State only answers a refused rotation: nothing to resend.
		if (this.online) this.endRotation("refused");
		else if (epoch === this.epoch) await this.goOnline();
		await this.settle();
	}

	private async offerSeed(epoch: number): Promise<void> {
		const disk = toLf(await this.deps.readDisk());
		const scratch = new Y.Doc();
		scratch.getText("body").insert(0, disk);
		const seed = Y.encodeStateAsUpdate(scratch);
		scratch.destroy();
		const payload = await seal(this.deps.keys, seed);
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
	private async reconcile(): Promise<void> {
		// Base first: a file sync writes the disk before the base, so the pair read is never base-ahead.
		const base = toLf(await this.deps.readBase());
		const disk = toLf(await this.deps.readDisk());
		this.reconciledFrom = disk;
		const room = this.text.toString();
		if (disk === room) return;
		patchYText(this.doc, this.text, mergeThreeWay(base, disk, room));
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
		await this.sendAwareness();
	}

	private async onFanout(frame: Frame<typeof EFrame.Fanout>): Promise<void> {
		// A pending seed is answered by its echo or by the whole room, so these add nothing.
		if (!this.inSync) return;
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
	 * that text is agreed, and a snapshot of it can replace the log.
	 */
	private async settle(): Promise<void> {
		if (!this.settled) return;
		this.deps.onAgreed(this.text.toString(), this.lastSeq);
		if (this.lastSeq - this.compacted < COMPACT_AFTER || !this.leads()) return;
		this.compacted = this.lastSeq;
		const snapshot = Y.encodeStateAsUpdate(this.doc);
		const payload = await seal(this.deps.keys, snapshot);
		if (this.online) {
			this.send({ type: EFrame.Snapshot, upto: this.compacted, payload });
		}
	}

	/** The lowest client id compacts, so the room gets one snapshot rather than one per device. */
	private leads(): boolean {
		for (const id of this.awareness.getStates().keys()) {
			if (id < this.doc.clientID) return false;
		}
		return true;
	}

	private async onPeer(frame: Frame<typeof EFrame.Peer>): Promise<void> {
		const update = await unseal(this.deps.keys, frame.payload);
		if (update) applyAwarenessUpdate(this.awareness, update, frame.from);
	}

	private onMoved(target: string): void {
		this.moved = target;
		this.endRotation("moved");
		this.deps.onMoved();
	}

	private endRotation(outcome: Rotation): void {
		this.rotation?.(outcome);
		this.rotation = null;
	}

	/** The first local edit names who typed it; keyed by client, concurrent entries never collide. */
	private attribute(): void {
		if (this.attributed) return;
		this.attributed = true;
		this.doc.getMap(USERS).set(String(this.doc.clientID), this.deps.person);
	}

	private onLeave(from: number): void {
		const clients = this.peers.get(from);
		this.peers.delete(from);
		if (clients) removeAwarenessStates(this.awareness, [...clients], REMOTE);
	}

	private dropPeers(): void {
		const clients: number[] = [];
		for (const ids of this.peers.values()) clients.push(...ids);
		this.peers.clear();
		removeAwarenessStates(this.awareness, clients, REMOTE);
	}

	private async apply(payload: Uint8Array): Promise<void> {
		const update = await unseal(this.deps.keys, payload);
		// A frame this key cannot open was sealed under another passphrase.
		if (update) Y.applyUpdate(this.doc, update, REMOTE);
	}

	/** Unacked before sealing: an edit is always pending or unacked until its echo. */
	private async sendUpdate(update: Uint8Array): Promise<void> {
		this.unacked.push(update);
		const payload = await seal(this.deps.keys, update);
		if (this.online) this.send({ type: EFrame.Update, payload });
	}

	private async sendAwareness(): Promise<void> {
		const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
		const payload = await seal(this.deps.keys, update);
		if (this.online) this.send({ type: EFrame.Awareness, payload });
	}

	private send(frame: Unaddressed): void {
		this.deps.hub.send({
			...frame,
			slot: VAULT_SLOT,
			doc: this.docId,
		} as ClientFrame);
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
		this.pending.push(update);
		this.attribute();
		this.updateTimer ??= window.setTimeout(() => {
			this.updateTimer = null;
			// Taken inside the step: taken early, an echo queued before it would
			// see nothing pending and agree on text the room does not have yet.
			this.enqueue(() => {
				const merged = this.takePending();
				return merged && this.sendUpdate(merged);
			});
		}, FLUSH_MS);
	};

	private readonly onAwareness = (
		{ added, updated, removed }: AwarenessChanges,
		origin: unknown,
	): void => {
		if (origin === LOCAL_AWARENESS) {
			if (this.disposed) return;
			this.awarenessTimer ??= window.setTimeout(() => {
				this.awarenessTimer = null;
				this.enqueue(() => this.sendAwareness());
			}, FLUSH_MS);
			return;
		}
		if (typeof origin !== "number") return;
		const clients = this.peers.get(origin) ?? new Set<number>();
		for (const id of [...added, ...updated]) clients.add(id);
		for (const id of removed) clients.delete(id);
		this.peers.set(origin, clients);
	};

	private clearTimers(): void {
		if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
		if (this.awarenessTimer !== null) window.clearTimeout(this.awarenessTimer);
		this.updateTimer = null;
		this.awarenessTimer = null;
	}
}
