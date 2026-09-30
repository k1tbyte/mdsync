import { OWNER } from "@obsync/protocol";

import type { RelayStatus } from "@/hub/status";
import type { Person } from "@/presence";
import type { Participant } from "@/storage";
import { RELAY_TEXT, UNREADABLE_TEXT } from "@/ui/common";

export interface ShareRow {
	key: string;
	name: string;
	detail: string;
	/** Null while they are not in the share's channel. */
	person: Person | null;
	/** Null where the owner's list is not available: nothing to revoke. */
	participant: Participant | null;
}

/** Those holding access when the owner knows them, else whoever is here; the ones here first. */
export function shareRows(
	here: readonly Person[],
	participants: readonly Participant[] | null,
): ShareRow[] {
	const present = new Map(here.map((person) => [person.key, person]));
	const rows = participants
		? participants.map((each) => accessRow(each, present.get(each.id)))
		: here.map(presentRow);
	return rows.sort(
		(a, b) =>
			Number(b.person !== null) - Number(a.person !== null) ||
			a.name.localeCompare(b.name),
	);
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
	const role = participant.readOnly ? "Read-only" : "Can edit";
	return {
		key: participant.id,
		name: participant.label || "Unnamed",
		detail: detailOf(role, person),
		person: person ?? null,
		participant,
	};
}

function presentRow(person: Person): ShareRow {
	return {
		key: person.key,
		name: person.name,
		detail: detailOf(person.key === OWNER ? "Owner" : null, person),
		person,
		participant: null,
	};
}

function detailOf(role: string | null, person?: Person): string {
	return [role, person && placeOf(person)].filter(Boolean).join(" - ");
}

function placeOf({ idle, note }: Person): string {
	if (idle) return "Away";
	return note === null
		? "Online"
		: `In ${note.slice(note.lastIndexOf("/") + 1)}`;
}
