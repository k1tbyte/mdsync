import * as Y from "yjs";

import type { LiveSession } from "./session";
import { TextModel } from "./text-model";

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

/** Every other device's cursor in the room; none in a drawing. */
export function cursorsIn(session: LiveSession): RoomCursor[] {
	const { model } = session;
	if (!(model instanceof TextModel)) return [];
	const out: RoomCursor[] = [];
	for (const [client, state] of session.awareness.getStates()) {
		if (client === session.doc.clientID) continue;
		const { user, cursor } = state as CursorState;
		if (typeof user?.key !== "string" || !cursor?.head) continue;
		const at = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(cursor.head),
			session.doc,
		);
		if (!at || at.type !== model.text) continue;
		out.push({ key: user.key, name: String(user.name ?? ""), at: at.index });
	}
	return out;
}
