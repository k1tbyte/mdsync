/**
 * Who else is in a room and where their cursor is. The hub never stores awareness: a newcomer learns about
 * us only from what we announce.
 */

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import type * as Y from "yjs";

import type { LiveKeys } from "@/crypto/live-keys";
import { type SealedFor, seal, unseal } from "@/crypto/seal";

/** Own changes go at most this often: a drag or a drawing's pointer moves 10 times a second. */
export const ANNOUNCE_MS = 100;
/** Origin of the states dropped for a peer gone: never this device's own. */
const DEPARTED = "departed";
/** The origin y-protocols gives this device's own awareness changes. */
export const LOCAL_AWARENESS = "local";
/** Set in a reader's awareness state: it never writes, so it never compacts. */
export const FOLLOWS = "follows";

interface AwarenessChanges {
	added: number[];
	updated: number[];
	removed: number[];
}

export interface RoomAwarenessIo {
	keys: LiveKeys;
	docId: string;
	canSend(): boolean;
	send(payload: Uint8Array): void;
	/** Runs `step` in the session's queue, behind everything already sealing. */
	enqueue(step: () => unknown): void;
}

export class RoomAwareness {
	readonly awareness: Awareness;
	/**
	 * Awareness client -> the hub socket that last announced it: a late Leave of an old socket clears
	 * nothing re-announced since.
	 */
	private readonly sources = new Map<number, number>();
	/** Hub sockets of the others here: alone, nothing announced reaches anyone, and a Join asks again. */
	private readonly others = new Set<number>();
	/** Changed while alone: the next one met learns it. */
	private unsent = false;
	private timer: number | null = null;
	/** Monotonic: a clock set back would hold the next send for as long. */
	private announcedAt = Number.NEGATIVE_INFINITY;
	private disposed = false;

	private readonly sealedFor: SealedFor;

	constructor(
		private readonly doc: Y.Doc,
		private readonly io: RoomAwarenessIo,
	) {
		this.sealedFor = `awareness:${io.docId}`;
		this.awareness = new Awareness(doc);
		this.awareness.on("update", this.onUpdate);
	}

	async announce(): Promise<void> {
		// Reconnect announces again (goOnline), so nothing sealed now would be missed.
		if (!this.io.canSend()) return;
		const { clientID, meta } = this.awareness;
		const own = meta.get(clientID);
		// Peers ignore a clock they have seen: one that dropped this state would never take it back.
		if (own) meta.set(clientID, { ...own, clock: own.clock + 1 });
		this.unsent = false;
		const update = encodeAwarenessUpdate(this.awareness, [clientID]);
		const payload = await seal(this.io.keys, update, this.sealedFor);
		if (this.io.canSend()) this.io.send(payload);
	}

	async receive(payload: Uint8Array, from: number): Promise<void> {
		if (!this.others.has(from)) {
			this.others.add(from);
			if (this.unsent) this.announceSoon();
		}
		const update = await unseal(this.io.keys, payload, this.sealedFor);
		if (update) applyAwarenessUpdate(this.awareness, update, from);
	}

	/** Awareness is never stored: a newcomer learns this device's state only from it. */
	joined(from: number): void {
		this.others.add(from);
		this.announceSoon();
	}

	depart(from: number): void {
		this.others.delete(from);
		this.forget(
			[...this.sources].filter(([, tag]) => tag === from).map(([id]) => id),
		);
	}

	dropAll(): void {
		this.others.clear();
		this.forget([...this.sources.keys()]);
	}

	/** The lowest writer's client id compacts, so the room gets one snapshot rather than one per device. */
	leads(): boolean {
		const states = this.awareness.getStates();
		if (states.get(this.doc.clientID)?.[FOLLOWS]) return false;
		for (const [id, state] of states) {
			if (id < this.doc.clientID && !state[FOLLOWS]) return false;
		}
		return true;
	}

	stopTimer(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
		this.awareness.destroy();
	}

	private readonly onUpdate = (
		{ added, updated, removed }: AwarenessChanges,
		origin: unknown,
	): void => {
		if (origin === LOCAL_AWARENESS) {
			this.announceSoon();
			return;
		}
		if (typeof origin !== "number") return;
		for (const id of [...added, ...updated]) this.sources.set(id, origin);
		for (const id of removed) this.sources.delete(id);
	};

	private forget(clients: number[]): void {
		for (const id of clients) this.sources.delete(id);
		removeAwarenessStates(this.awareness, clients, DEPARTED);
	}

	/** At once after a quiet window, then once per window; the heartbeat comes through here too. */
	private announceSoon(): void {
		if (this.disposed || this.alone()) return;
		const wait = Math.max(
			0,
			this.announcedAt + ANNOUNCE_MS - performance.now(),
		);
		this.timer ??= window.setTimeout(
			() => this.io.enqueue(() => this.announceDue()),
			wait,
		);
	}

	/** Held as pending until the queue runs it: a backed-up queue then sends the latest state once. */
	private async announceDue(): Promise<void> {
		this.timer = null;
		if (this.disposed || this.alone()) return;
		this.announcedAt = performance.now();
		await this.announce();
	}

	private alone(): boolean {
		if (this.others.size === 0) this.unsent = true;
		return this.others.size === 0;
	}
}
