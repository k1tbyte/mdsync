import { EFrame, OWNER, type ServerFrame } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";

import { type Announcement, openAnnouncement } from "./announcement";

interface Vouched {
	who: string;
	name: string;
}

/**
 * Who else holds one channel, per hub socket. Sealed announcements wait for the
 * key: they are sent once per join. A client can seal any name, but not the
 * `who` the hub vouches for its socket. `unlock` and `apply` resolve true when
 * what is shown changed.
 */
export class ChannelPresence {
	private readonly sealed = new Map<number, Uint8Array>();
	private readonly open = new Map<number, Announcement>();
	private readonly vouched = new Map<number, Vouched>();
	private readonly unreadable = new Set<number>();
	private keys: LiveKeys | null = null;
	private self: string | null = null;

	constructor(private readonly onEntriesChange: () => void) {}

	async unlock(keys: LiveKeys, self: string): Promise<boolean> {
		const selfChanged = this.self !== self;
		if (selfChanged) {
			this.self = self;
			this.onEntriesChange();
		}
		if (this.keys === keys) return selfChanged;
		this.keys = keys;
		const opened = await Promise.all(
			[...this.sealed].map(([from, payload]) => this.decode(from, payload)),
		);
		return selfChanged || opened.some(Boolean);
	}

	async apply(frame: ServerFrame): Promise<boolean> {
		if (frame.type === EFrame.Join || frame.type === EFrame.Here) {
			const { from, who, name } = frame;
			this.vouched.set(from, { who, name });
			const shown = this.open.has(from);
			if (shown) this.onEntriesChange();
			return shown;
		}
		if (frame.type === EFrame.Leave) {
			this.vouched.delete(frame.from);
			this.sealed.delete(frame.from);
			const wasUnreadable = this.unreadable.delete(frame.from);
			return this.dropOpen(frame.from) || wasUnreadable;
		}
		if (frame.type !== EFrame.Peer) return false;
		this.sealed.set(frame.from, frame.payload);
		return this.decode(frame.from, frame.payload);
	}

	/** Sealed announcements are kept: a key back in reach reads them again. */
	lock(): void {
		this.keys = null;
		this.open.clear();
		this.unreadable.clear();
		this.onEntriesChange();
	}

	clear(): void {
		this.vouched.clear();
		this.sealed.clear();
		this.open.clear();
		this.unreadable.clear();
		this.onEntriesChange();
	}

	isLocked(): boolean {
		return this.keys === null;
	}

	/** Someone here holds another passphrase or key. */
	hasUnreadable(): boolean {
		return this.unreadable.size > 0;
	}

	/** This device's own key left out; a participant under their invited name. */
	entries(): Announcement[] {
		const out: Announcement[] = [];
		for (const [from, announcement] of this.open) {
			const vouched = this.vouched.get(from);
			if (!vouched || announcement.key === this.self) continue;
			// The owner may be anyone of theirs; a participant only themselves.
			if (vouched.who === OWNER) out.push(announcement);
			else if (vouched.who === announcement.key) {
				out.push({ ...announcement, name: vouched.name || announcement.name });
			}
		}
		return out;
	}

	nameOf(person: string): string | null {
		for (const { who, name } of this.vouched.values()) {
			if (who === person && name !== "") return name;
		}
		// The relay vouches only the owner's key: their own announcement names them.
		for (const [from, announcement] of this.open) {
			const vouched = this.vouched.get(from);
			if (vouched?.who === person && announcement.key === person) {
				return announcement.name;
			}
		}
		return null;
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
			return this.dropOpen(from) || !wasUnreadable;
		}
		this.unreadable.delete(from);
		this.open.set(from, announcement);
		this.onEntriesChange();
		return true;
	}

	private dropOpen(from: number): boolean {
		const dropped = this.open.delete(from);
		if (dropped) this.onEntriesChange();
		return dropped;
	}
}
