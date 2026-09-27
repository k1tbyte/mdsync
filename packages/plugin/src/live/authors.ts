/**
 * Who typed what: each session names the person behind its client id at its
 * first edit. Advisory: the entry is written by the client itself, inside the
 * ciphertext, so anyone who may write the note may also misname it.
 */

import type * as Y from "yjs";

/** Client id -> Author; keyed by client, so concurrent registrations never overwrite each other. */
export const USERS = "users";

/** Cursor hue per person (or device), so the same one keeps its colour on every screen. */
const HUE_STEPS = 12;

export interface Author {
	/** Who the relay knows them as. */
	person: string;
	name: string;
}

export interface AuthorRange {
	from: number;
	to: number;
	author: Author;
}

/** Null for a client nobody named, or an entry that is not an Author. */
export function authorOf(users: Y.Map<unknown>, client: number): Author | null {
	const value = users.get(String(client));
	if (typeof value !== "object" || value === null) return null;
	const { person, name } = value as Record<string, unknown>;
	return typeof person === "string" && typeof name === "string"
		? { person, name }
		: null;
}

export function authorColors(key: string): {
	color: string;
	colorLight: string;
} {
	let hash = 0;
	for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	const hue = (hash % HUE_STEPS) * (360 / HUE_STEPS);
	return {
		color: `hsl(${hue}, 70%, 50%)`,
		colorLight: `hsla(${hue}, 70%, 50%, 0.2)`,
	};
}

/**
 * What others typed inside `ranges` (sorted, as CodeMirror's visible ranges),
 * in document order. Walks the text only up to the last range.
 */
export function authorRanges(
	text: Y.Text,
	users: Y.Map<unknown>,
	ranges: readonly { from: number; to: number }[],
	me: string,
): AuthorRange[] {
	const out: AuthorRange[] = [];
	const end = ranges.at(-1)?.to ?? 0;
	const known = new Map<number, Author | null>();
	let at = 0;
	for (let item = text._start; item && at < end; item = item.right) {
		if (item.deleted || !item.countable) continue;
		const from = at;
		at += item.length;
		const client = item.id.client;
		if (!known.has(client)) known.set(client, authorOf(users, client));
		const author = known.get(client);
		if (!author || author.person === me) continue;
		for (const range of ranges) {
			const start = Math.max(from, range.from);
			const stop = Math.min(at, range.to);
			if (start >= stop) continue;
			const last = out.at(-1);
			if (last?.to === start && last.author.person === author.person) {
				last.to = stop;
			} else {
				out.push({ from: start, to: stop, author });
			}
		}
	}
	return out;
}
