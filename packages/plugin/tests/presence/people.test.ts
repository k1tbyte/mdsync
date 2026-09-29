import { EFrame, type ServerFrame } from "@obsync/protocol";
import { describe, expect, it, vi } from "vitest";

import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import type { SpaceFrame, SpaceListener } from "@/hub/connection";
import { openAnnouncement, sealAnnouncement } from "@/presence/announcement";
import { People, type PresenceAccess } from "@/presence/people";
import { type Space, VAULT_SPACE } from "@/sync/space";

interface Device {
	tag: number;
	people: People;
	listeners: Map<SpaceListener, string>;
	connected: boolean;
}

/** Forwards channel awareness to every other device in the channel, as the hub does. */
class Relay {
	private readonly devices: Device[] = [];

	add(
		spaces: Space[],
		access: (space: Space) => Promise<PresenceAccess | null>,
	): Device {
		const device: Device = {
			tag: this.devices.length + 1,
			listeners: new Map(),
			connected: false,
			people: null as unknown as People,
		};
		device.people = new People({
			hub: {
				space: (id) => ({
					send: (frame) => this.forward(device, id, frame),
					isConnected: () => device.connected,
					listen: (listener) => {
						device.listeners.set(listener, id);
						return () => device.listeners.delete(listener);
					},
				}),
			},
			spaces: () => spaces,
			access,
		});
		device.people.refresh();
		this.devices.push(device);
		return device;
	}

	join(device: Device): void {
		device.connected = true;
		for (const listener of device.listeners.keys()) {
			listener.onConnectionChange?.(true);
		}
		this.toOthers(device, () => ({
			type: EFrame.Join,
			slot: 0,
			doc: "",
			from: device.tag,
			who: "",
		}));
	}

	leave(device: Device): void {
		device.connected = false;
		for (const listener of device.listeners.keys()) {
			listener.onConnectionChange?.(false);
		}
		this.toOthers(device, () => ({
			type: EFrame.Leave,
			slot: 0,
			doc: "",
			from: device.tag,
		}));
	}

	private forward(from: Device, space: string, frame: SpaceFrame): void {
		if (frame.type !== EFrame.Awareness) return;
		this.toOthers(
			from,
			() => ({
				type: EFrame.Peer,
				slot: 0,
				doc: "",
				from: from.tag,
				payload: frame.payload,
			}),
			space,
		);
	}

	private toOthers(
		from: Device,
		frame: () => ServerFrame,
		space?: string,
	): void {
		for (const device of this.devices) {
			if (device === from || !device.connected) continue;
			for (const [listener, id] of device.listeners) {
				if (space === undefined || id === space) listener.onFrame?.(frame());
			}
		}
	}
}

const SHARE_ID = "s1";

function keys(): Promise<LiveKeys> {
	return deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
}

function spacesWith(root: string): Space[] {
	return [VAULT_SPACE, { id: SHARE_ID, root }];
}

async function setup() {
	const vaultKeys = await keys();
	const shareKeys = await keys();
	const relay = new Relay();
	const accessFor =
		(device: string, person: string, name: string) => async (space: Space) =>
			space.id === SHARE_ID
				? { keys: shareKeys, key: person, name }
				: { keys: vaultKeys, key: device, name: device };
	return { relay, accessFor, vaultKeys, shareKeys };
}

describe("people", () => {
	it("see who has a shared note open, on their own mount of the folder", async () => {
		const { relay, accessFor } = await setup();
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		const friend = relay.add(
			spacesWith("Shared/Team"),
			accessFor("d9", "p1", "Alex"),
		);
		relay.join(owner);
		relay.join(friend);

		owner.people.setHere({ path: "Team/a.md", idle: false });

		await vi.waitFor(() =>
			expect(friend.people.inNote("Shared/Team/a.md")).toEqual([
				{ key: "owner", name: "Owner", note: "Shared/Team/a.md", idle: false },
			]),
		);
		expect(friend.people.online(SHARE_ID)).toHaveLength(1);
		expect(owner.people.inNote("Team/a.md")).toEqual([]);
	});

	it("leave a person's own devices out of a share, not out of the vault", async () => {
		const { relay, accessFor } = await setup();
		const laptop = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		const phone = relay.add(
			spacesWith("Team"),
			accessFor("d2", "owner", "Owner"),
		);
		relay.join(laptop);
		relay.join(phone);

		laptop.people.setHere({ path: "Team/a.md", idle: false });

		await vi.waitFor(() =>
			expect(phone.people.devices().devices).toEqual([
				{ id: "d1", name: "d1" },
			]),
		);
		expect(phone.people.online(VAULT_SPACE.id)[0]?.note).toBeNull();
		expect(phone.people.online(SHARE_ID)).toEqual([]);
	});

	it("flag someone they cannot read, until that device leaves", async () => {
		const { relay, accessFor } = await setup();
		const strangerKeys = await keys();
		const laptop = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		const stranger = relay.add(spacesWith("Team"), async () => ({
			keys: strangerKeys,
			key: "d2",
			name: "d2",
		}));
		const seen: boolean[] = [];
		laptop.people.subscribe(() =>
			seen.push(laptop.people.unreadable(VAULT_SPACE.id)),
		);
		relay.join(laptop);
		relay.join(stranger);

		await vi.waitFor(() =>
			expect(laptop.people.unreadable(VAULT_SPACE.id)).toBe(true),
		);
		expect(laptop.people.online(VAULT_SPACE.id)).toEqual([]);
		expect(seen).toContain(true);

		relay.leave(stranger);

		await vi.waitFor(() =>
			expect(laptop.people.unreadable(VAULT_SPACE.id)).toBe(false),
		);
		expect(seen.at(-1)).toBe(false);
	});

	it("read announcements that came before the key once it is known", async () => {
		const { relay, accessFor } = await setup();
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		let unlocked = false;
		const late = accessFor("d9", "p1", "Alex");
		const friend = relay.add(spacesWith("Team"), async (space) =>
			unlocked ? late(space) : null,
		);
		relay.join(friend);
		relay.join(owner);
		owner.people.setHere({ path: "Team/a.md", idle: false });
		await vi.waitFor(() => expect(friend.people.devices().locked).toBe(true));

		unlocked = true;
		friend.people.refresh();

		await vi.waitFor(() =>
			expect(friend.people.inNote("Team/a.md")).toHaveLength(1),
		);
		expect(friend.people.devices().locked).toBe(false);
	});

	it("follow a person going idle and leaving", async () => {
		const { relay, accessFor } = await setup();
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		const friend = relay.add(spacesWith("Team"), accessFor("d9", "p1", "Alex"));
		relay.join(owner);
		relay.join(friend);
		friend.people.setHere({ path: "Team/a.md", idle: false });
		await vi.waitFor(() =>
			expect(owner.people.inNote("Team/a.md")).toHaveLength(1),
		);

		friend.people.setHere({ path: "Team/a.md", idle: true });
		await vi.waitFor(() =>
			expect(owner.people.inNote("Team/a.md")[0]?.idle).toBe(true),
		);

		relay.leave(friend);
		await vi.waitFor(() => expect(owner.people.online(SHARE_ID)).toEqual([]));
	});
});

describe("presence announcements", () => {
	it("keep notes inside the root and cap names", async () => {
		const sealed = await keys();
		const open = async (note: unknown, name = "Alex") =>
			openAnnouncement(
				sealed,
				await sealAnnouncement(sealed, {
					key: "p1",
					name,
					note: note as string,
					idle: false,
				}),
			);

		expect((await open("a/b.md"))?.note).toBe("a/b.md");
		expect((await open("../x.md"))?.note).toBeNull();
		expect((await open("/etc/x"))?.note).toBeNull();
		expect((await open("a.md", "x".repeat(200)))?.name).toHaveLength(64);
		expect(await open("a.md", "  ")).toBeNull();
	});
});
