/**
 * Live notes as the file sync sees them. A version is a room snapshot when it
 * is the note's agreed text; an open room takes incoming text itself and saves
 * the result, so the sync never writes over its note.
 */

import { sha256Hex } from "@/crypto";
import {
	type IncomingText,
	isNewerMark,
	type LiveNotes,
	type LiveTake,
} from "@/sync/live-notes";
import type { LiveMark } from "@/sync/types";
import { toLf } from "@/utils/eol";

import type { AgreedTexts } from "./agreed-texts";
import type { LiveSession } from "./session";
import type { LiveSessions } from "./sessions";
import { docIdIn, type LiveSpace } from "./space";

export interface LiveColdSyncDeps {
	rooms: Pick<
		LiveSessions,
		"roomOf" | "joining" | "save" | "spaceOf" | "expectWrite"
	>;
	agreed: AgreedTexts;
	/** The space this sync session runs in. */
	space: string;
	/** Its keys and root; null while it cannot go live. */
	live(): Promise<LiveSpace | null>;
}

const encoder = new TextEncoder();
const LIVE_EXTENSION = ".md";

export class LiveColdSync implements LiveNotes {
	constructor(private readonly deps: LiveColdSyncDeps) {}

	async mark(path: string, hash: string): Promise<LiveMark | "later" | null> {
		// Only notes go live; anything else would cost a key derivation per file.
		if (!path.endsWith(LIVE_EXTENSION)) return null;
		if (this.elsewhere(path) || this.deps.rooms.joining(path)) return "later";
		const room = this.deps.rooms.roomOf(path);
		// Unsettled, the file may still be a text the room has moved past.
		if (room && !room.settled) return "later";
		const doc = await this.docOf(path);
		const agreed = doc ? await this.deps.agreed.get(doc) : null;
		if (
			doc &&
			agreed &&
			(await sha256Hex(encoder.encode(agreed.text))) === hash
		) {
			return { doc, gen: agreed.gen, seq: agreed.seq };
		}
		return room ? "later" : null;
	}

	async absorb(
		path: string,
		mark: LiveMark | undefined,
		texts: () => Promise<IncomingText | null>,
	): Promise<LiveTake> {
		if (this.elsewhere(path)) return "later";
		const room = this.deps.rooms.roomOf(path);
		// Written now, the file would be read back as the open's disk and undo what came in.
		if (!room && this.deps.rooms.joining(path)) return "later";
		if (!room) {
			this.deps.rooms.expectWrite(path);
			return "cold";
		}
		if (!(await this.foldInto(room, path, mark, texts))) return "later";
		// The sync records the remote version as seen; the file must already hold it.
		return (await this.deps.rooms.save(path)) ? "taken" : "later";
	}

	/** False when the room is not there yet, or closed or moved while the incoming text was fetched. */
	private async foldInto(
		room: LiveSession,
		path: string,
		mark: LiveMark | undefined,
		texts: () => Promise<IncomingText | null>,
	): Promise<boolean> {
		const snapshot = mark?.doc === (await this.docOf(path)) ? mark : undefined;
		const incoming = snapshot ? null : await texts();
		if (this.deps.rooms.roomOf(path) !== room) return false;
		if (snapshot) {
			return !isNewerMark(snapshot, { gen: room.generation, seq: room.seq });
		}
		// A deletion leaves the open note be: edits outlive it.
		if (incoming) room.absorb(incoming.base, incoming.incoming);
		return true;
	}

	async wrote(path: string, mark: LiveMark, text: string): Promise<void> {
		if (mark.doc !== (await this.docOf(path))) return;
		const { doc, gen, seq } = mark;
		this.deps.agreed.put(doc, { text: toLf(text), gen, seq });
	}

	/** The note's first docId, which names it across rotations. */
	private async docOf(path: string): Promise<string | null> {
		const space = await this.deps.live();
		return space ? docIdIn(space, path, 0) : null;
	}

	/** Open in another space's room: this sync's partition is behind, the room answers once it catches up. */
	private elsewhere(path: string): boolean {
		const space = this.deps.rooms.spaceOf(path);
		return space !== null && space !== this.deps.space;
	}
}
