import { OWNER } from "@obsync/protocol";
import {
	keys,
	SHARE_ID,
	setup,
	spacesWith,
} from "@tests/helpers/presence-relay";
import { describe, expect, it, vi } from "vitest";

import { openAnnouncement, sealAnnouncement } from "@/presence/announcement";
import { People } from "@/presence/people";
import { VAULT_SPACE } from "@/sync/space";

describe("people", () => {
	it("open no channel once disposed", () => {
		const space = vi.fn(() => ({ listen: () => () => {} }));
		const people = new People({
			hub: { space } as never,
			spaces: () => [VAULT_SPACE],
			access: async () => null,
		});

		people.dispose();
		people.refresh();

		expect(space).not.toHaveBeenCalled();
		expect(people.online(VAULT_SPACE.id)).toEqual([]);
	});

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

	it("name a participant as the relay vouches, and hide one claiming another's key", async () => {
		const { relay, accessFor } = await setup();
		const vouched = (who: string) => (space: string) =>
			space === SHARE_ID ? { who, name: "Alex" } : { who: OWNER, name: "" };
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		relay.join(owner);
		const alex = relay.add(
			spacesWith("Shared/Team"),
			accessFor("d8", "p1", "Not Alex"),
			vouched("p1"),
		);
		const impostor = relay.add(
			spacesWith("Shared/Team"),
			accessFor("d9", "p1", "Alex"),
			vouched("p2"),
		);
		relay.join(alex);
		relay.join(impostor);

		alex.people.setHere({ path: "Shared/Team/a.md", idle: false });
		impostor.people.setHere({ path: "Shared/Team/b.md", idle: false });

		await vi.waitFor(() =>
			expect(owner.people.inNote("Team/a.md")).toMatchObject([
				{ key: "p1", name: "Alex" },
			]),
		);
		expect(owner.people.inNote("Team/b.md")).toEqual([]);
		expect(owner.people.nameOf(SHARE_ID, "p1")).toBe("Alex");
		expect(owner.people.nameOf(SHARE_ID, OWNER)).toBeNull();
		expect(alex.people.online(SHARE_ID)).toMatchObject([
			{ key: "owner", name: "Owner" },
		]);
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

	it("drop what they read once the key is out of reach, and read it again when it is back", async () => {
		const { relay, accessFor } = await setup();
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		let unlocked = true;
		const access = accessFor("d9", "p1", "Alex");
		const friend = relay.add(spacesWith("Team"), async (space) =>
			unlocked ? access(space) : null,
		);
		relay.join(friend);
		relay.join(owner);
		owner.people.setHere({ path: "Team/a.md", idle: false });
		await vi.waitFor(() =>
			expect(friend.people.inNote("Team/a.md")).toHaveLength(1),
		);

		unlocked = false;
		friend.people.refresh();
		await vi.waitFor(() => expect(friend.people.devices().locked).toBe(true));
		expect(friend.people.inNote("Team/a.md")).toEqual([]);

		unlocked = true;
		friend.people.refresh();
		await vi.waitFor(() =>
			expect(friend.people.inNote("Team/a.md")).toHaveLength(1),
		);
	});

	it("go on announcing after one announcement failed to seal", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { relay, accessFor } = await setup();
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		const friend = relay.add(
			spacesWith("Shared/Team"),
			accessFor("d9", "p1", "Alex"),
		);
		relay.join(friend);
		relay.join(owner);
		await vi.waitFor(() =>
			expect(friend.people.online(SHARE_ID)).toHaveLength(1),
		);
		const encrypt = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockRejectedValueOnce(new Error("sealing failed"));

		owner.people.setHere({ path: "Team/a.md", idle: false });
		await vi.waitFor(() => expect(warn).toHaveBeenCalled());
		owner.people.setHere({ path: "Team/b.md", idle: false });

		await vi.waitFor(() =>
			expect(friend.people.inNote("Shared/Team/b.md")).toHaveLength(1),
		);
		encrypt.mockRestore();
		warn.mockRestore();
	});

	it("tell a newcomer the unchanged announcement without sealing it again", async () => {
		const { relay, accessFor } = await setup();
		const forward = vi.spyOn(
			relay as unknown as { forward: () => void },
			"forward",
		);
		const owner = relay.add(
			spacesWith("Team"),
			accessFor("d1", "owner", "Owner"),
		);
		owner.people.setHere({ path: "Team/a.md", idle: false });
		relay.join(owner);
		await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(2));
		const encrypt = vi.spyOn(crypto.subtle, "encrypt");

		relay.join(relay.add(spacesWith("Team"), async () => null));

		await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(4));
		expect(encrypt).not.toHaveBeenCalled();
		encrypt.mockRestore();
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
