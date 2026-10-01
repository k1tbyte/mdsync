import * as Y from "yjs";

import type { LiveSession } from "@/live/session";
import { TextModel } from "./model";

interface CursorState {
	user?: { key?: unknown; name?: unknown };
	cursor?: { head?: unknown };
}

export interface RoomCursor {
	key: string;
	name: string;
	at: number;
}

/** Every other device's cursor in the room, or only `key`'s; none in a drawing. */
export function cursorsIn(session: LiveSession, key?: string): RoomCursor[] {
	const { model } = session;
	if (!(model instanceof TextModel)) return [];
	const out: RoomCursor[] = [];
	for (const [client, state] of session.awareness.getStates()) {
		if (client === session.doc.clientID) continue;
		const { user, cursor } = state as CursorState;
		if (typeof user?.key !== "string" || !cursor?.head) continue;
		if (key !== undefined && user.key !== key) continue;
		const at = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(cursor.head),
			session.doc,
		);
		if (!at || at.type !== model.text) continue;
		out.push({ key: user.key, name: String(user.name ?? ""), at: at.index });
	}
	return out;
}

export interface WatchedCursor {
	/** Null while they have no cursor, as with their window out of focus. */
	at(): number | null;
	present(): boolean;
	/** Calls `changed` whenever the cursor may have moved or the room closed; returns the unsubscribe. */
	watch(changed: () => void): () => void;
}

export function watchCursor(session: LiveSession, key: string): WatchedCursor {
	const { awareness } = session;
	return {
		at: () => cursorsIn(session, key)[0]?.at ?? null,
		present: () =>
			[...awareness.getStates().values()].some(
				(state) => (state as CursorState).user?.key === key,
			),
		// Edits move a cursor without a new awareness state: it is relative to the text.
		watch(changed) {
			awareness.on("change", changed);
			session.doc.on("update", changed);
			session.doc.on("destroy", changed);
			return () => {
				awareness.off("change", changed);
				session.doc.off("update", changed);
				session.doc.off("destroy", changed);
			};
		},
	};
}
