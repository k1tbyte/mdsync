/**
 * Who typed what: each session names the person behind its client id at its first edit. Advisory: anyone
 * who may write the note may misname it.
 */

import type * as Y from "yjs";

/** Client id -> Author; keyed by client, so concurrent registrations never overwrite each other. */
export const USERS = "users";

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

/** Names `author` as the person behind this doc's client, once: on their first edit. */
export function attribute(doc: Y.Doc, author: Author): void {
	const users = doc.getMap(USERS);
	const client = String(doc.clientID);
	if (!users.has(client)) users.set(client, author);
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

/**
 * What others typed inside `ranges` (sorted, as CodeMirror's visible ranges), in document order; walks the
 * text only up to the last range.
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
