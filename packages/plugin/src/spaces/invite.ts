/**
 * An invite link carries everything a participant's devices need to reach a
 * share, sealed under a one-time password that travels another way.
 */

import { isShareId } from "@obsync/protocol";

import { randomBytes } from "@/crypto";
import { LINK_PARAM, openLink, sealLink } from "@/crypto/sealed-link";

import type { ShareAccess, SpaceRecord } from "./record";

export const INVITE_ACTION = "obsync-share";

export interface Invite {
	id: string;
	name: string;
	/** The share's data key, base64. */
	key: string;
	relayUrl: string;
	token: string;
	/** Who the relay knows this person as: their edits are attributed to it. */
	participantId: string;
	/** What the owner called them: their cursor and their text carry it. */
	personName: string;
	/** The broker refuses this person's writes; their device stops offering them. */
	readOnly: boolean;
}

/** Crockford's base32: no I, L, O or U to misread. */
const PASSWORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const PASSWORD_GROUPS = 3;
const PASSWORD_GROUP_LENGTH = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function inviteLink(
	invite: Invite,
	password: string,
): Promise<string> {
	const token = await sealLink(
		encoder.encode(JSON.stringify(invite)),
		password,
	);
	return `obsidian://${INVITE_ACTION}?${LINK_PARAM}=${token}`;
}

/** Throws on a wrong password or a link that is not an invite. */
export async function readInvite(
	link: string,
	password: string,
): Promise<Invite> {
	const payload: unknown = JSON.parse(
		decoder.decode(await openLink(link, password)),
	);
	if (!isInvite(payload)) throw new Error("This link is not an Obsync invite.");
	return payload;
}

/** The participant's own record of the share, mounted at `root`. */
export function acceptInvite(
	invite: Invite,
	root: string,
	author: string,
	/** A share this person left before: the new record must outrank it. */
	previous?: SpaceRecord,
): SpaceRecord {
	const { id, name, key } = invite;
	return {
		id,
		name,
		root,
		rev: (previous?.rev ?? 0) + 1,
		author,
		key,
		access: inviteAccess(invite),
	};
}

/** How the invited person reaches the share: what a new link replaces. */
export function inviteAccess(invite: Invite): ShareAccess {
	const { relayUrl, token, participantId, personName, readOnly } = invite;
	return {
		kind: "participant",
		relayUrl,
		token,
		participantId,
		personName,
		...(readOnly ? { readOnly } : {}),
	};
}

/** 60 random bits in groups of four, easy to read out. */
export function invitePassword(): string {
	const bytes = randomBytes(PASSWORD_GROUPS * PASSWORD_GROUP_LENGTH);
	const chars = [...bytes].map(
		(byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length],
	);
	const groups: string[] = [];
	for (let at = 0; at < chars.length; at += PASSWORD_GROUP_LENGTH) {
		groups.push(chars.slice(at, at + PASSWORD_GROUP_LENGTH).join(""));
	}
	return groups.join("-");
}

function isInvite(value: unknown): value is Invite {
	if (typeof value !== "object" || value === null) return false;
	const invite = value as Record<string, unknown>;
	return (
		["id", "name", "key", "relayUrl", "token", "participantId"].every(
			(field) => typeof invite[field] === "string" && invite[field] !== "",
		) &&
		isShareId(invite.id as string) &&
		typeof invite.personName === "string" &&
		typeof invite.readOnly === "boolean"
	);
}
