/** Each device announces its open file to the space holding it and "elsewhere" to the rest. */

import { CHANNEL_DOC, EFrame } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";
import type { HubConnection, SpaceHub } from "@/hub";
import { reportWarning } from "@/shared/diagnostics";
import {
	insideOf,
	type Space,
	spaceOf,
	VAULT_SPACE,
	vaultPathOf,
} from "@/sync/space";

import { type Announcement, sealAnnouncement } from "./announcement";
import { ChannelPresence } from "./channel";
import { byNote, onePerPerson, type Person } from "./views";

export type { Person } from "./views";

export interface Here {
	path: string | null;
	idle: boolean;
}

export interface PresenceAccess {
	keys: LiveKeys;
	key: string;
	name: string;
}

export interface PeopleDeps {
	hub: Pick<HubConnection, "space">;
	/** Paused spaces flagged; the same array until the partition changes. */
	spaces(): readonly Space[];
	access(space: Space): Promise<PresenceAccess | null>;
}

interface Channel {
	space: Space;
	hub: SpaceHub;
	presence: ChannelPresence;
	access: PresenceAccess | null;
	unlocking: boolean;
	/** Asked again mid-unlock: the answer in flight may be stale. */
	again: boolean;
	sent: string | null;
	/** The last announcement sealed: each newcomer is told it again without sealing anew. */
	sealed: { text: string; keys: LiveKeys; payload: Uint8Array } | null;
	/** Sealing is async, so sends are chained to keep their order. */
	sending: Promise<void>;
	unlisten(): void;
}

interface Views {
	online: Map<string, readonly Person[]>;
	notes?: ReadonlyMap<string, readonly Person[]>;
}

export class People {
	private readonly channels = new Map<string, Channel>();
	private readonly listeners = new Set<() => void>();
	private here: Here = { path: null, idle: false };
	private views: Views | null = null;
	private partition: readonly Space[] | null = null;
	private disposed = false;

	constructor(private readonly deps: PeopleDeps) {}

	/** Channels follow the partition; access is read again either way. */
	refresh(): void {
		// A late settings change must not reopen the channels of an unloaded plugin.
		if (this.disposed) return;
		const partition = this.deps.spaces();
		const moved = partition !== this.partition;
		if (moved) this.follow(partition);
		for (const channel of this.channels.values()) this.unlock(channel);
		if (moved) this.emit();
	}

	private follow(partition: readonly Space[]): void {
		this.partition = partition;
		this.views = null;
		const spaces = partition.filter((space) => !space.paused);
		const ids = new Set(spaces.map((space) => space.id));
		for (const [id, channel] of this.channels) {
			if (ids.has(id)) continue;
			channel.unlisten();
			this.channels.delete(id);
		}
		for (const space of spaces) {
			const channel = this.channels.get(space.id);
			if (channel) channel.space = space;
			else this.channels.set(space.id, this.open(space));
		}
	}

	setHere(here: Here): void {
		this.here = here;
		for (const channel of this.channels.values()) {
			if (channel.access) this.announce(channel);
			else this.unlock(channel);
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** One entry per person: the most present of their devices. */
	online(spaceId: string): readonly Person[] {
		const { online } = this.viewsNow();
		let people = online.get(spaceId);
		if (!people) {
			const channel = this.channels.get(spaceId);
			people = channel ? onePerPerson(this.peopleIn(channel)) : [];
			online.set(spaceId, people);
		}
		return people;
	}

	unreadable(spaceId: string): boolean {
		return this.channels.get(spaceId)?.presence.hasUnreadable() ?? false;
	}

	nameOf(spaceId: string, person: string): string | null {
		return this.channels.get(spaceId)?.presence.nameOf(person) ?? null;
	}

	/** Who has this file open; idle only when all their devices on it are. */
	inNote(path: string): readonly Person[] {
		return this.notes().get(path) ?? [];
	}

	notes(): ReadonlyMap<string, readonly Person[]> {
		const views = this.viewsNow();
		views.notes ??= byNote(
			[...this.channels.values()].map((channel) => this.peopleIn(channel)),
		);
		return views.notes;
	}

	/** `locked` while the vault key is out of reach: no device can be read. */
	devices(): { locked: boolean; devices: { id: string; name: string }[] } {
		const vault = this.channels.get(VAULT_SPACE.id);
		const locked = vault?.presence.isLocked() ?? false;
		const devices = this.online(VAULT_SPACE.id).map(({ key, name }) => ({
			id: key,
			name,
		}));
		return { locked, devices };
	}

	dispose(): void {
		this.disposed = true;
		for (const channel of this.channels.values()) channel.unlisten();
		this.channels.clear();
		this.views = null;
		this.listeners.clear();
	}

	private open(space: Space): Channel {
		const hub = this.deps.hub.space(space.id);
		const channel: Channel = {
			space,
			hub,
			presence: new ChannelPresence(() => {
				this.views = null;
			}),
			access: null,
			unlocking: false,
			again: false,
			sent: null,
			sealed: null,
			sending: Promise.resolve(),
			unlisten: () => {},
		};
		channel.unlisten = hub.listen({
			onConnectionChange: (connected) => {
				channel.sent = null;
				if (connected) this.unlock(channel);
				else channel.presence.clear();
				this.emit();
			},
			onFrame: (frame) => {
				if (frame.doc !== CHANNEL_DOC) return;
				// Presence is never stored: each newcomer must be told again.
				if (frame.type === EFrame.Join) {
					channel.sent = null;
					this.announce(channel);
				}
				void channel.presence.apply(frame).then((changed) => {
					if (changed) this.emit();
				});
			},
		});
		return channel;
	}

	/** Read again each time: the device may have been renamed or its key come within reach. */
	private unlock(channel: Channel): void {
		if (channel.unlocking) {
			channel.again = true;
			return;
		}
		channel.unlocking = true;
		channel.again = false;
		void this.deps
			.access(channel.space)
			.then(async (access) => {
				if (this.channels.get(channel.space.id) !== channel) return;
				if (!access) return this.lock(channel);
				const { name, keys } = channel.access ?? {};
				if (name !== access.name || keys !== access.keys) channel.sent = null;
				channel.access = access;
				const changed = await channel.presence.unlock(access.keys, access.key);
				this.announce(channel);
				if (changed) this.emit();
			})
			.catch((err: unknown) => {
				reportWarning("Presence could not open a space's channel.", err);
			})
			.finally(() => {
				channel.unlocking = false;
				if (channel.again) this.unlock(channel);
			});
	}

	/** The key went out of reach: nothing is read or announced until it is back. */
	private lock(channel: Channel): void {
		if (!channel.access) return;
		channel.access = null;
		channel.sent = null;
		channel.sealed = null;
		channel.presence.lock();
		this.emit();
	}

	private announce(channel: Channel): void {
		const { access, space, hub } = channel;
		if (!access || !hub.isConnected()) return;
		const announcement: Announcement = {
			key: access.key,
			name: access.name,
			note: this.noteIn(space),
			idle: this.here.idle,
		};
		const text = JSON.stringify(announcement);
		if (channel.sent === text) return;
		channel.sent = text;
		channel.sending = channel.sending
			.then(async () => {
				const { keys } = access;
				const kept = channel.sealed;
				const payload =
					kept?.text === text && kept.keys === keys
						? kept.payload
						: await sealAnnouncement(keys, announcement);
				channel.sealed = { text, keys, payload };
				hub.send({ type: EFrame.Awareness, doc: CHANNEL_DOC, payload });
			})
			// Caught, or one failure would leave the chain rejected and the channel silent.
			.catch((err: unknown) => {
				if (channel.sent === text) channel.sent = null;
				reportWarning("Presence could not announce this device.", err);
			});
	}

	private noteIn(space: Space): string | null {
		const { path } = this.here;
		if (path === null) return null;
		if (spaceOf(this.deps.spaces(), path).id !== space.id) return null;
		return insideOf(space, path);
	}

	private viewsNow(): Views {
		this.views ??= { online: new Map() };
		return this.views;
	}

	private peopleIn(channel: Channel): Person[] {
		const { space } = channel;
		return channel.presence.entries().map(({ key, name, note, idle }) => ({
			key,
			name,
			note: note === null ? null : vaultPathOf(space, note),
			idle,
		}));
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
