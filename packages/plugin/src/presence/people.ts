/**
 * Who is where across every space this device holds a relay channel for. Each
 * device announces the file it has open to the space holding it and "elsewhere"
 * to the rest, so people are seen in a shared folder without opening its notes.
 */

import { CHANNEL_DOC, EFrame } from "@obsync/protocol";

import type { LiveKeys } from "@/crypto/live-keys";
import type { HubConnection, SpaceHub } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";

import { type Announcement, sealAnnouncement } from "./announcement";
import { ChannelPresence } from "./channel";

export interface Person {
	/** Groups and colours: the person in a share, the device in the vault. */
	key: string;
	name: string;
	/** The vault path of their open file; null while it is elsewhere. */
	note: string | null;
	idle: boolean;
}

/** This device's open file and whether its person is at it. */
export interface Here {
	path: string | null;
	idle: boolean;
}

/** What this device holds in a space's channel: its key, and who it is there. */
export interface PresenceAccess {
	keys: LiveKeys;
	key: string;
	name: string;
}

export interface PeopleDeps {
	hub: Pick<HubConnection, "space">;
	/** The partition now: every space, paused ones flagged. */
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
	/** Last announcement sent, so an unchanged one is not sent again. */
	sent: string | null;
	/** Sends in order: sealing is async. */
	sending: Promise<void>;
	unlisten(): void;
}

export class People {
	private readonly channels = new Map<string, Channel>();
	private readonly listeners = new Set<() => void>();
	private here: Here = { path: null, idle: false };

	constructor(private readonly deps: PeopleDeps) {}

	/** Follows the partition: a share mounted, moved, paused or closed. */
	refresh(): void {
		const spaces = this.deps.spaces().filter((space) => !space.paused);
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
		for (const channel of this.channels.values()) this.unlock(channel);
		this.emit();
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

	/** Everyone in the space's channel, one entry per person, the most present of their devices. */
	online(spaceId: string): Person[] {
		const channel = this.channels.get(spaceId);
		if (!channel) return [];
		const byKey = new Map<string, Person>();
		for (const person of this.peopleIn(channel)) {
			const known = byKey.get(person.key);
			if (!known || presenceRank(person) > presenceRank(known)) {
				byKey.set(person.key, person);
			}
		}
		return sortByName([...byKey.values()]);
	}

	/** Whether someone in the space's channel cannot be read: they hold another passphrase or key. */
	unreadable(spaceId: string): boolean {
		return this.channels.get(spaceId)?.presence.hasUnreadable() ?? false;
	}

	/** Who has this file open; idle only when all their devices on it are. */
	inNote(path: string): Person[] {
		return this.notes().get(path) ?? [];
	}

	/** Vault path -> who has it open, across every space. */
	notes(): Map<string, Person[]> {
		const byNote = new Map<string, Map<string, Person>>();
		for (const channel of this.channels.values()) {
			for (const person of this.peopleIn(channel)) {
				if (person.note === null) continue;
				const here = byNote.get(person.note) ?? new Map<string, Person>();
				const known = here.get(person.key);
				here.set(person.key, {
					...person,
					idle: person.idle && (known?.idle ?? true),
				});
				byNote.set(person.note, here);
			}
		}
		return new Map(
			[...byNote].map(([note, people]) => [
				note,
				sortByName([...people.values()]),
			]),
		);
	}

	/** The vault's other devices; `locked` while its key is out of reach, so none can be read. */
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
		for (const channel of this.channels.values()) channel.unlisten();
		this.channels.clear();
		this.listeners.clear();
	}

	private open(space: Space): Channel {
		const hub = this.deps.hub.space(space.id);
		const channel: Channel = {
			space,
			hub,
			presence: new ChannelPresence(),
			access: null,
			unlocking: false,
			again: false,
			sent: null,
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
				// Presence is never stored, so every newcomer is told who is here.
				if (frame.type === EFrame.Join) {
					channel.sent = null;
					this.announce(channel);
					return;
				}
				void channel.presence.apply(frame).then((changed) => {
					if (changed) this.emit();
				});
			},
		});
		return channel;
	}

	/** Access is read again each time: the device may have been renamed, the key come within reach. */
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
				if (!access || this.channels.get(channel.space.id) !== channel) return;
				if (channel.access?.name !== access.name) channel.sent = null;
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
		channel.sending = channel.sending.then(async () => {
			const payload = await sealAnnouncement(access.keys, announcement);
			hub.send({ type: EFrame.Awareness, doc: CHANNEL_DOC, payload });
		});
	}

	/** This device's open file inside the space, relative to its root. */
	private noteIn(space: Space): string | null {
		const { path } = this.here;
		if (path === null) return null;
		if (spaceOf(this.deps.spaces(), path).id !== space.id) return null;
		return space.root === "" ? path : path.slice(space.root.length + 1);
	}

	private peopleIn(channel: Channel): Person[] {
		const { root } = channel.space;
		return channel.presence.entries().map(({ key, name, note, idle }) => ({
			key,
			name,
			note: note === null ? null : pathIn(root, note),
			idle,
		}));
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function pathIn(root: string, inside: string): string {
	return root === "" ? inside : `${root}/${inside}`;
}

function presenceRank(person: Person): number {
	return (person.idle ? 0 : 2) + (person.note === null ? 0 : 1);
}

function sortByName(people: Person[]): Person[] {
	return people.sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.key.localeCompare(right.key),
	);
}
