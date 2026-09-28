import * as Y from "yjs";

import type { LiveSession } from "./session";

interface CursorState {
	user?: { key?: unknown; name?: unknown };
	cursor?: { head?: unknown };
}

export interface RoomCursor {
	/** The presence key: whose cursor this is. */
	key: string;
	name: string;
	/** Offset in the room's text. */
	at: number;
}

/** Every other device's cursor in the room. */
export function cursorsIn(session: LiveSession): RoomCursor[] {
	const out: RoomCursor[] = [];
	for (const [client, state] of session.awareness.getStates()) {
		if (client === session.doc.clientID) continue;
		const { user, cursor } = state as CursorState;
		if (typeof user?.key !== "string" || !cursor?.head) continue;
		const at = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(cursor.head),
			session.doc,
		);
		if (at?.type !== session.text) continue;
		out.push({ key: user.key, name: String(user.name ?? ""), at: at.index });
	}
	return out;
}
