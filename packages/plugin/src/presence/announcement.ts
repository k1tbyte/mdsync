import type { LiveKeys } from "@/crypto/live-keys";
import { seal, unseal } from "@/live/seal";

/** One device's place in a space, sealed whole: the relay learns no names or paths. */
export interface Announcement {
	/** Groups and colours: the person in a share, the device in the vault. */
	key: string;
	name: string;
	/** The open file inside the space root; null while it is elsewhere. */
	note: string | null;
	idle: boolean;
}

/** Announcements come from others, so their fields are capped here. */
const MAX_FIELD_LENGTH = 64;
const MAX_NOTE_LENGTH = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sealAnnouncement(
	keys: LiveKeys,
	announcement: Announcement,
): Promise<Uint8Array> {
	return seal(keys, encoder.encode(JSON.stringify(announcement)));
}

/** Null for anything this key cannot open or that is not an announcement. */
export async function openAnnouncement(
	keys: LiveKeys,
	payload: Uint8Array,
): Promise<Announcement | null> {
	const plain = await unseal(keys, payload);
	if (!plain) return null;
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(plain));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const { key, name, note, idle } = value as Record<string, unknown>;
	if (typeof key !== "string" || typeof name !== "string") return null;
	const announcement = {
		key: clamp(key),
		name: clamp(name),
		note: isNote(note) ? note : null,
		idle: idle === true,
	};
	return announcement.key && announcement.name ? announcement : null;
}

function clamp(field: string): string {
	return field.trim().slice(0, MAX_FIELD_LENGTH);
}

/** A path that stays inside the root it is joined to. */
function isNote(note: unknown): note is string {
	return (
		typeof note === "string" &&
		note.length > 0 &&
		note.length <= MAX_NOTE_LENGTH &&
		!note.startsWith("/") &&
		!note.split("/").includes("..")
	);
}
