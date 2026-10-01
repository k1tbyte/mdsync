/**
 * Live notes as the file sync sees them: a version is a room snapshot when it is the note's agreed text,
 * and an open room takes incoming text itself.
 */

import { sha256Hex } from "@/crypto";
import { hasLiveExtension } from "@/live/doc-types";
import type { LiveSession } from "@/live/session";
import type { LiveSessions } from "@/live/workspace/sessions";
import { docIdIn, type LiveSpace } from "@/live/workspace/space";
import { textToBytes } from "@/sync/content";
import {
	type IncomingText,
	isNewerMark,
	type LiveNotes,
	type LiveTake,
} from "@/sync/live-notes";
import type { LiveMark } from "@/sync/types";
import { toLf } from "@/utils";
import type { AgreedTexts } from "./agreed-texts";

export interface LiveColdSyncDeps {
	rooms: Pick<
		LiveSessions,
		"roomOf" | "joining" | "save" | "spaceOf" | "expectWrite"
	>;
	agreed: AgreedTexts;
	space: string;
	/** Its keys and root; null while it cannot go live. */
	live(): Promise<LiveSpace | null>;
	kept(path: string): void;
}

export class LiveColdSync implements LiveNotes {
	constructor(private readonly deps: LiveColdSyncDeps) {}

	async mark(path: string, hash: string): Promise<LiveMark | "later" | null> {
		if (!hasLiveExtension(path)) return null;
		if (this.elsewhere(path) || this.deps.rooms.joining(path)) return "later";
		const room = this.deps.rooms.roomOf(path);
		// Unsettled, the file may still be a text the room has moved past.
		if (room && !room.settled) return "later";
		// Asked per pushed note: skip its key derivation when nothing could match.
		if (!room && (await this.deps.agreed.none())) return null;
		const doc = await this.docOf(path);
		const agreed = doc ? await this.deps.agreed.get(doc) : null;
		if (doc && agreed && (await sha256Hex(textToBytes(agreed.text))) === hash) {
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
		return !incoming || room.absorb(incoming.base, incoming.incoming);
	}

	async wrote(path: string, mark: LiveMark, text: string): Promise<void> {
		if (mark.doc !== (await this.docOf(path))) return;
		const { doc, gen, seq } = mark;
		this.deps.agreed.put(doc, { text: toLf(text), gen, seq });
	}

	holds(path: string): boolean {
		const { rooms } = this.deps;
		return (
			this.elsewhere(path) || rooms.roomOf(path) !== null || rooms.joining(path)
		);
	}

	kept(path: string): void {
		this.deps.kept(path);
	}

	/** The note's first docId, which names it across rotations. */
	private async docOf(path: string): Promise<string | null> {
		const space = await this.deps.live();
		return space ? docIdIn(space, path, 0) : null;
	}

	/** Open in another space's room: this sync's partition is behind and catches up. */
	private elsewhere(path: string): boolean {
		const space = this.deps.rooms.spaceOf(path);
		return space !== null && space !== this.deps.space;
	}
}
