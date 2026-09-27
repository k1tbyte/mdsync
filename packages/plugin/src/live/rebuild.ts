/**
 * A Y.Doc only grows: deleted text stays as tombstones. Rotation moves a note
 * into a fresh document holding just its text, and the authorship with it.
 */

import * as Y from "yjs";

import { USERS } from "./authors";

export const BODY = "body";

/** The text as a fresh document; each run keeps the client id that typed it, and that client's author. */
export function rebuild(source: Y.Doc): Uint8Array {
	const doc = new Y.Doc();
	const text = doc.getText(BODY);
	const typed = new Set<string>();
	let at = 0;
	for (let item = source.getText(BODY)._start; item; item = item.right) {
		if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
		doc.clientID = item.id.client;
		typed.add(String(item.id.client));
		text.insert(at, item.content.str);
		at += item.length;
	}
	const users = doc.getMap(USERS);
	for (const [client, author] of source.getMap(USERS)) {
		if (typed.has(client)) users.set(client, author);
	}
	const update = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return update;
}
