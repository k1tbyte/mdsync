/**
 * Who else is in a room and where their cursor is. Awareness is never stored
 * on the hub, so a newcomer only learns about us from what we announce.
 */

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import type * as Y from "yjs";

import type { LiveKeys } from "@/crypto/live-keys";

import { seal, unseal } from "./seal";

/** Cursors batch this long, like edits. */
const FLUSH_MS = 250;
/** Marks what came off the wire, so it is never sent back. */
const REMOTE = Symbol("remote");
/** The origin y-protocols gives this device's own awareness changes. */
export const LOCAL_AWARENESS = "local";

interface AwarenessChanges {
	added: number[];
	updated: number[];
	removed: number[];
}

export interface RoomAwarenessIo {
	keys: LiveKeys;
	/** Announcements may go out: the socket has answered. */
	canSend(): boolean;
	send(payload: Uint8Array): void;
	/** Runs `step` in the session's queue, behind everything already sealing. */
	enqueue(step: () => unknown): void;
}

export class RoomAwareness {
	readonly awareness: Awareness;
	/** Hub socket tag -> the awareness clients it announced, so its Leave clears them. */
	private readonly peers = new Map<number, Set<number>>();
	private timer: number | null = null;
	private disposed = false;

	constructor(
		private readonly doc: Y.Doc,
		private readonly io: RoomAwarenessIo,
	) {
		this.awareness = new Awareness(doc);
		this.awareness.on("update", this.onUpdate);
	}

	async announce(): Promise<void> {
		const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
		const payload = await seal(this.io.keys, update);
		if (this.io.canSend()) this.io.send(payload);
	}

	async receive(payload: Uint8Array, from: number): Promise<void> {
		const update = await unseal(this.io.keys, payload);
		if (update) applyAwarenessUpdate(this.awareness, update, from);
	}

	depart(from: number): void {
		const clients = this.peers.get(from);
		this.peers.delete(from);
		if (clients) removeAwarenessStates(this.awareness, [...clients], REMOTE);
	}

	dropAll(): void {
		const clients = [...this.peers.values()].flatMap((ids) => [...ids]);
		this.peers.clear();
		removeAwarenessStates(this.awareness, clients, REMOTE);
	}

	/** The lowest client id compacts, so the room gets one snapshot rather than one per device. */
	leads(): boolean {
		for (const id of this.awareness.getStates().keys()) {
			if (id < this.doc.clientID) return false;
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
		const clients = this.peers.get(origin) ?? new Set<number>();
		for (const id of [...added, ...updated]) clients.add(id);
		for (const id of removed) clients.delete(id);
		this.peers.set(origin, clients);
	};

	private announceSoon(): void {
		if (this.disposed) return;
		this.timer ??= window.setTimeout(() => {
			this.timer = null;
			this.io.enqueue(() => this.announce());
		}, FLUSH_MS);
	}
}
