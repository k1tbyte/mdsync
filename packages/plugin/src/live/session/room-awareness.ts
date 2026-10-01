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
import { FLUSH_MS } from "./outbox";

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
	private timer: number | null = null;
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
		const { clientID, meta } = this.awareness;
		const own = meta.get(clientID);
		// Peers ignore a clock they have seen: one that dropped this state would never take it back.
		if (own) meta.set(clientID, { ...own, clock: own.clock + 1 });
		const update = encodeAwarenessUpdate(this.awareness, [clientID]);
		const payload = await seal(this.io.keys, update, this.sealedFor);
		if (this.io.canSend()) this.io.send(payload);
	}

	async receive(payload: Uint8Array, from: number): Promise<void> {
		const update = await unseal(this.io.keys, payload, this.sealedFor);
		if (update) applyAwarenessUpdate(this.awareness, update, from);
	}

	depart(from: number): void {
		this.forget(
			[...this.sources].filter(([, tag]) => tag === from).map(([id]) => id),
		);
	}

	dropAll(): void {
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

	private announceSoon(): void {
		if (this.disposed) return;
		this.timer ??= window.setTimeout(() => {
			this.timer = null;
			this.io.enqueue(() => this.announce());
		}, FLUSH_MS);
	}
}
