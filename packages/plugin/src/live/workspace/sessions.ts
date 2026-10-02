/**
 * A session exists while its file is open in a view that edits it live; every such leaf is bound once the
 * room answered. A moved room hands its leaves to its successor, a renamed file takes its room along.
 */

import type { WorkspaceLeaf } from "obsidian";
import type { BoundEditor } from "@/live/model";
import { closedBefore, type LiveSession } from "@/live/session";
import type { Rotation } from "@/live/session/session-deps";
import { reportWarning } from "@/shared";
import { EDITORS, type OpenNote, openNotes } from "./editors";
import { JoinPatience, type Waiting, waitingSince } from "./patience";
import { moveRoom } from "./rename";
import {
	type ColdCause,
	type OpenAt,
	type Room,
	type RoomDeps,
	RoomOpener,
} from "./room";
import { docIdIn, type LiveSpace, sameSpace } from "./space";

export type { ColdCause } from "./room";

/** Live, on its way to a room, or why it was left to the file sync; null when nothing holds it. */
export type NoteState = "live" | Waiting | ColdCause | null;

const LOADING_RETRY_MS = 500;

const UNFOLLOWED = new Set<ColdCause>(["empty", "diverged"]);

export interface LiveSessionsDeps extends RoomDeps {
	authorsShown(): boolean;
}

interface Binding {
	path: string;
	session: LiveSession;
	/** Whose text is left untinted: this device's person in the room's space. */
	person: string;
	editor: BoundEditor;
}

type ShownSpaces = Map<string, LiveSpace>;

export class LiveSessions {
	private readonly rooms = new Map<string, Room>();
	private readonly bound = new Map<WorkspaceLeaf, Binding>();
	/** Open notes left to the file sync: their room moved elsewhere, or the hub cannot carry them. */
	private readonly cold = new Map<string, ColdCause>();
	private readonly listeners = new Set<() => void>();
	private readonly opener: RoomOpener;
	private running = false;
	private again = false;
	private disposed = false;
	/** A pass for views still loading: nothing announces when they are ready. */
	private retry: number | null = null;
	private readonly patience = new JoinPatience(() => {
		this.notify();
		this.armPatience();
	});

	constructor(private readonly deps: LiveSessionsDeps) {
		this.opener = new RoomOpener(deps, {
			alive: () => !this.disposed,
			refresh: () => void this.refresh(),
			leave: (path, cause) => this.leave(path, cause),
		});
	}

	/** Coalesces: a refresh asked for mid-run runs once more after it. Never rejects. */
	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		do {
			this.again = false;
			try {
				await this.run();
			} catch (err) {
				reportWarning("Live editing could not follow the open notes.", err);
			}
		} while (this.again && !this.disposed);
		this.running = false;
		this.notify();
		this.armPatience();
	}

	/** Told after every refresh: a room joined, bound or left. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Resolves once every room sent its last edits and left. */
	dispose(): Promise<void> {
		this.disposed = true;
		if (this.retry !== null) window.clearTimeout(this.retry);
		this.patience.stop();
		this.listeners.clear();
		for (const { editor } of this.bound.values()) editor.detach();
		this.bound.clear();
		const closing = [...this.rooms.values()].map(({ session }) => {
			session.dispose();
			return closedBefore(session.docId) ?? Promise.resolve();
		});
		this.rooms.clear();
		this.cold.clear();
		void this.deps.agreed.dispose();
		return Promise.all(closing).then(() => undefined);
	}

	/** The note's room once an editor is bound to it; null while closed, joining or moving. */
	roomOf(path: string): LiveSession | null {
		const room = this.rooms.get(path);
		// Moving, the room is still the old path's: the note's own answers from the new one.
		if (!room?.session.synced || room.lineage !== path) return null;
		const isBound = [...this.bound.values()].some((each) => each.path === path);
		return isBound ? room.session : null;
	}

	/** "unanswered": the hub is up but the room stayed silent past the time it takes to answer. */
	noteState(path: string): NoteState {
		if (this.roomOf(path)) return "live";
		return this.waiting(path) ?? this.cold.get(path) ?? null;
	}

	/** On its way to a room the hub can deliver; a dead hub or a silent room leaves the file to the sync. */
	joining(path: string): boolean {
		return this.noteState(path) === "joining";
	}

	/** The space whose room holds the note, open or joining; null while it is cold. */
	spaceOf(path: string): string | null {
		return this.rooms.get(path)?.space.id ?? null;
	}

	repaintAuthors(): void {
		const shown = this.deps.authorsShown();
		for (const { person, editor } of this.bound.values()) {
			editor.showAuthors(shown ? person : null);
		}
	}

	async rotate(path: string): Promise<Rotation> {
		const session = this.roomOf(path);
		const room = this.rooms.get(path);
		if (!session || room?.lineage !== path) return "busy";
		return session.rotate(
			await docIdIn(room.space, path, session.generation + 1),
		);
	}

	/** Saves the note's bound editor now, so its file holds what the room has; false when nothing could. */
	async save(path: string): Promise<boolean> {
		const editor = this.rooms.get(path)?.editor;
		const leaf = [...this.bound].find(([, each]) => each.path === path)?.[0];
		return editor && leaf ? editor.save(leaf.view) : false;
	}

	/** The file sync writes `path` next: every view showing it, live or not, takes the write in. */
	expectWrite(path: string): void {
		const { workspace } = this.deps.app;
		for (const editor of Object.values(EDITORS)) {
			for (const leaf of workspace.getLeavesOfType(editor.viewType)) {
				editor.expectWrite(leaf.view, path);
			}
		}
	}

	private async run(): Promise<void> {
		const open = await openNotes(this.deps.app, this.deps.liveSpace);
		if (this.disposed) return;
		const shown: ShownSpaces = new Map(
			[...open.values()].map(({ file, space }) => [file.path, space]),
		);
		this.carryRenamed(shown);
		this.detachStale(open, shown);
		await this.closeLeftRooms(shown);
		this.forgetColdCauses(shown);
		if (this.disposed) return;
		await this.bindOpenNotes(open);
	}

	/** A renamed file keeps its TFile: its room goes along and moves to the new path. */
	private carryRenamed(shown: ShownSpaces): void {
		for (const [path, room] of [...this.rooms]) {
			const to = room.file.path;
			const space = shown.get(to);
			if (to === path || this.rooms.has(to) || !room.session.synced) continue;
			if (!space || !sameSpace(space, room.space)) continue;
			this.rooms.delete(path);
			this.rooms.set(to, room);
			for (const binding of this.bound.values()) {
				if (binding.path === path) binding.path = to;
			}
		}
		for (const [path, room] of this.rooms) {
			const moving = room.lineage !== path && room.renamingTo === null;
			if (!moving || !room.session.synced) continue;
			room.renamingTo = path;
			void this.relocate(path, room);
		}
	}

	private async relocate(path: string, room: Room): Promise<void> {
		const { session, space } = room;
		const still = () => this.rooms.get(path) === room;
		const hub = this.deps.hub.space(space.id);
		// Moved: the pointer's arrival refreshes, and the room is followed there.
		if ((await moveRoom(session, space, hub, path, still)) === "moved") return;
		room.renamingTo = null;
		// Renamed again meanwhile, the next pass moves it on; nowhere to go, the note starts over at its path.
		if (still()) {
			this.rooms.delete(path);
			session.dispose();
		}
		void this.refresh();
	}

	private detachStale(
		open: Map<WorkspaceLeaf, OpenNote>,
		shown: ShownSpaces,
	): void {
		for (const [leaf, binding] of this.bound) {
			const { path, session, editor } = binding;
			const room = this.rooms.get(path);
			const current =
				open.get(leaf)?.file.path === path &&
				room?.session === session &&
				this.stays(shown, path, room) &&
				!editor.stale?.();
			if (current) continue;
			editor.detach();
			this.bound.delete(leaf);
		}
	}

	private async closeLeftRooms(shown: ShownSpaces): Promise<void> {
		for (const [path, room] of [...this.rooms]) {
			if (this.stays(shown, path, room)) continue;
			this.rooms.delete(path);
			room.session.dispose();
			const space = shown.get(path);
			const moved = room.session.movedTo !== null;
			if (moved && space && sameSpace(space, room.space)) {
				await this.follow(path, room);
			}
		}
	}

	/** A note that changed space (moved into a share, paused, new keys) leaves its old room. */
	private stays(shown: ShownSpaces, path: string, room: Room): boolean {
		const space = shown.get(path);
		return (
			space !== undefined &&
			sameSpace(space, room.space) &&
			room.session.movedTo === null &&
			!this.cold.has(path)
		);
	}

	/** Closed, a note tries again on its next open; a reader's also once they may write. */
	private forgetColdCauses(shown: ShownSpaces): void {
		for (const [path, cause] of this.cold) {
			const space = shown.get(path);
			if (!space || (UNFOLLOWED.has(cause) && !space.readOnly)) {
				this.cold.delete(path);
			}
		}
	}

	private async bindOpenNotes(
		open: Map<WorkspaceLeaf, OpenNote>,
	): Promise<void> {
		for (const [leaf, note] of open) {
			const { file, space, editor } = note;
			if (this.bound.has(leaf) || this.cold.has(file.path)) continue;
			const room =
				this.rooms.get(file.path) ?? (await this.open(file, space, editor));
			if (this.disposed || !room) return;
			// Binding before the room answered would publish this device's text as agreed.
			if (!room.session.synced) continue;
			if (room.editor.fileOf(leaf.view) !== file) continue;
			this.bind(leaf, note, room);
		}
	}

	private bind(leaf: WorkspaceLeaf, { file, space }: OpenNote, room: Room) {
		const { person } = space;
		const editor = room.bind(
			leaf.view,
			this.deps.authorsShown() ? person : null,
			() => void this.refresh(),
		);
		if (!editor) {
			this.retry ??= window.setTimeout(() => {
				this.retry = null;
				void this.refresh();
			}, LOADING_RETRY_MS);
			return;
		}
		this.bound.set(leaf, {
			path: file.path,
			session: room.session,
			person,
			editor,
		});
	}

	private async open(
		file: OpenNote["file"],
		space: LiveSpace,
		editor: OpenNote["editor"],
		at?: OpenAt,
	): Promise<Room | null> {
		const room = await this.opener.open(file, space, editor, at);
		if (room) this.rooms.set(file.path, room);
		return room;
	}

	private async follow(path: string, from: Room): Promise<void> {
		const at = await this.opener.follow(path, from);
		if (at) await this.open(from.file, from.space, from.editor, at);
		else this.cold.set(path, "moved-away");
	}

	private leave(path: string, cause: ColdCause): void {
		this.cold.set(path, cause);
		void this.refresh();
	}

	/** Asked once `roomOf` said no: a room open for the note that has not answered yet. */
	private waiting(path: string): Waiting | null {
		const room = this.rooms.get(path);
		if (!room || !this.deps.hub.space(room.space.id).isConnected()) return null;
		// A moving room waits on its rename, not on an answer.
		if (room.lineage !== path) return "joining";
		return waitingSince(room.session.subscribedAt);
	}

	private armPatience(): void {
		const joining = [...this.rooms].filter(
			([path, room]) => room.lineage === path && this.joining(path),
		);
		this.patience.arm(joining.map(([, room]) => room.session.subscribedAt));
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}
