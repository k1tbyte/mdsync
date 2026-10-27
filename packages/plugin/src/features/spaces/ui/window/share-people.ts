import { OWNER } from "@mdsync/protocol";

import type { RelayStatus } from "@/core/hub";
import { RELAY_TEXT, UNREADABLE_TEXT } from "@/core/hub";
import type { Person } from "@/features/presence";
import type { Participant } from "../../broker/share-broker";
import { type SpaceRecord, shareIdentity } from "../../record";

export interface ShareRow {
	key: string;
	name: string;
	/** Where they are now. */
	detail: string;
	/** Null where this device cannot know it. */
	role: string | null;
	/** Null while they are not in the share's channel. */
	person: Person | null;
	/** Null where the owner's list is not available: nothing to revoke. */
	participant: Participant | null;
}

/**
 * Those holding access when the owner knows them, else whoever is here; the ones here first. `self` is this
 * person: their own row comes from `selfRow`, not from their other devices.
 */
export function shareRows(
	here: readonly Person[],
	participants: readonly Participant[] | null,
	self: string,
): ShareRow[] {
	const present = new Map(here.map((person) => [person.key, person]));
	const rows = participants
		? participants.map((each) => accessRow(each, present.get(each.id)))
		: here.filter(({ key }) => key !== self).map(presentRow);
	return rows.sort(
		(a, b) =>
			Number(b.person !== null) - Number(a.person !== null) ||
			a.name.localeCompare(b.name),
	);
}

/** This person, at `note` when the open note is in the share. */
export function selfRow(record: SpaceRecord, note: string | null): ShareRow {
	const { person, name } = shareIdentity(record);
	const { access } = record;
	return {
		key: person,
		name,
		detail: note === null ? "Online" : `In ${fileName(note)}`,
		role: access.kind === "owner" ? "Owner" : roleOf(access.readOnly === true),
		person: null,
		participant: null,
	};
}

/** Why the relay cannot show who is here; null when it can. */
export function presenceNote(
	status: RelayStatus,
	unreadable: boolean,
): string | null {
	if (status !== "connected") return `${RELAY_TEXT[status]}.`;
	return unreadable ? `${UNREADABLE_TEXT}.` : null;
}

function accessRow(participant: Participant, person?: Person): ShareRow {
	return {
		key: participant.id,
		name: participant.label || "Unnamed",
		detail: person ? placeOf(person) : "Not here now",
		role: roleOf(participant.readOnly),
		person: person ?? null,
		participant,
	};
}

function presentRow(person: Person): ShareRow {
	return {
		key: person.key,
		name: person.name,
		detail: placeOf(person),
		role: person.key === OWNER ? "Owner" : null,
		person,
		participant: null,
	};
}

function roleOf(readOnly: boolean): string {
	return readOnly ? "Read-only" : "Can edit";
}

function placeOf({ idle, note }: Person): string {
	if (idle) return "Away";
	return note === null ? "Online" : `In ${fileName(note)}`;
}

function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
