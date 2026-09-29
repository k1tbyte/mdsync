import { EFrame, type ServerFrame } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";

import { type Announcement, openAnnouncement } from "./announcement";

/**
 * Who else holds one channel, per hub socket. Sealed announcements are kept
 * until the key is known: they are sent once per join, not again.
 */
export class ChannelPresence {
	private readonly sealed = new Map<number, Uint8Array>();
	private readonly open = new Map<number, Announcement>();
	private readonly unreadable = new Set<number>();
	private keys: LiveKeys | null = null;
	private self: string | null = null;

	/** Resolves true when what it knows changed. */
	async unlock(keys: LiveKeys, self: string): Promise<boolean> {
		const selfChanged = this.self !== self;
		this.self = self;
		if (this.keys === keys) return selfChanged;
		this.keys = keys;
		const opened = await Promise.all(
			[...this.sealed].map(([from, payload]) => this.decode(from, payload)),
		);
		return selfChanged || opened.some(Boolean);
	}

	async apply(frame: ServerFrame): Promise<boolean> {
		if (frame.type === EFrame.Leave) {
			this.sealed.delete(frame.from);
			const wasUnreadable = this.unreadable.delete(frame.from);
			return this.open.delete(frame.from) || wasUnreadable;
		}
		if (frame.type !== EFrame.Peer) return false;
		this.sealed.set(frame.from, frame.payload);
		return this.decode(frame.from, frame.payload);
	}

	clear(): void {
		this.sealed.clear();
		this.open.clear();
		this.unreadable.clear();
	}

	isLocked(): boolean {
		return this.keys === null;
	}

	/** Someone is here whose announcement this key does not open: another passphrase. */
	hasUnreadable(): boolean {
		return this.unreadable.size > 0;
	}

	/** One per socket, this device's own key left out. */
	entries(): Announcement[] {
		return [...this.open.values()].filter(({ key }) => key !== this.self);
	}

	private async decode(from: number, payload: Uint8Array): Promise<boolean> {
		const keys = this.keys;
		if (!keys) return false;
		const announcement = await openAnnouncement(keys, payload);
		// A later announcement, a leave or a new key overtook this one.
		if (this.sealed.get(from) !== payload || this.keys !== keys) return false;
		if (!announcement) {
			const wasUnreadable = this.unreadable.has(from);
			this.unreadable.add(from);
			return this.open.delete(from) || !wasUnreadable;
		}
		this.unreadable.delete(from);
		this.open.set(from, announcement);
		return true;
	}
}
