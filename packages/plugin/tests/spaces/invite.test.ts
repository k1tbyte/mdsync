import { describe, expect, it } from "vitest";
import { sealLink } from "@/crypto/sealed-link";
import {
	acceptInvite,
	type Invite,
	inviteLink,
	invitePassword,
	readInvite,
} from "@/spaces/invite";
import { closeRecord, isSpaceRecord, mergeRecords } from "@/spaces/record";

const INVITE: Invite = {
	id: "share-1",
	name: "Team",
	key: "a2V5",
	relayUrl: "https://relay.example",
	token: "tok",
	participantId: "p1",
	personName: "Friend",
	readOnly: false,
};

describe("share invites", () => {
	it("open with their password into the participant's own record", async () => {
		const password = invitePassword();
		const link = await inviteLink(INVITE, password);

		expect(link.startsWith("obsidian://obsync-share?d=")).toBe(true);
		const record = acceptInvite(
			await readInvite(link, password),
			"Shared/Team",
			"phone",
		);
		expect(isSpaceRecord(record)).toBe(true);
		expect(record).toMatchObject({
			id: "share-1",
			root: "Shared/Team",
			access: {
				kind: "participant",
				relayUrl: INVITE.relayUrl,
				token: "tok",
				participantId: "p1",
				personName: "Friend",
			},
		});
	});

	it("tell a read-only participant's record so", async () => {
		const password = invitePassword();
		const link = await inviteLink({ ...INVITE, readOnly: true }, password);
		const record = acceptInvite(await readInvite(link, password), "x", "phone");

		expect(record.access).toMatchObject({ readOnly: true });
		expect(isSpaceRecord(record)).toBe(true);
		expect(acceptInvite(INVITE, "x", "phone").access).not.toHaveProperty(
			"readOnly",
		);
	});

	it("reopen a share this person left before", () => {
		const left = closeRecord(
			acceptInvite(INVITE, "Shared/Team", "phone"),
			"phone",
		);
		const again = acceptInvite(INVITE, "Elsewhere", "laptop", left);

		expect(mergeRecords([left], [again])).toEqual([again]);
		expect(again.closed).toBeUndefined();
	});

	it("stay shut to another password and to links that are not invites", async () => {
		const link = await inviteLink(INVITE, "right");
		await expect(readInvite(link, "wrong")).rejects.toThrow();

		const settings = await sealLink(new TextEncoder().encode("{}"), "right");
		await expect(readInvite(settings, "right")).rejects.toThrow(
			"not an Obsync invite",
		);
	});

	it("come with a readable password of 60 random bits", () => {
		const password = invitePassword();
		expect(password).toMatch(
			/^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){2}$/,
		);
		expect(invitePassword()).not.toBe(password);
	});
});
