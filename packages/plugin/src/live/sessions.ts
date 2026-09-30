/**
 * Which files are live: a session exists while its file is open in a view
 * that edits it live on this device (a note in source mode, a drawing in
 * Excalidraw), and every such leaf is bound to it once the room answered. A
 * room that moved hands its leaves to its successor; a renamed file takes its
 * room along. Closed files are the cold layer's business.
 */

import { ERefusal, type Refusal } from "@obsync/protocol";
import type { App, TFile, WorkspaceLeaf } from "obsidian";

import type { HubConnection } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";
import { toLf } from "@/utils/eol";

import type { AgreedTexts } from "./agreed-texts";
import { closedBefore } from "./closing";
import {
	EDITORS,
	type LiveEditor,
	type LiveRoom,
	openNotes,
	readOpen,
} from "./editors";
import type { BoundEditor } from "./model";
import { movedWith, moveRoom } from "./rename";
import type { LiveSession } from "./session";
import type { Rotation, Unfollowed } from "./session-deps";
import { docIdIn, type LiveSpace, sameSpace } from "./space";

const LOADING_RETRY_MS = 500;
/** A room answers in well under a second: past this it may never. */
const JOIN_PATIENCE_MS = 15_000;

/** Why an open note stays cold until it is closed. */
export type ColdCause =
	| "moved-away"
	| "too-large"
	| "too-many"
	| "read-only"
	| Unfollowed;

const UNFOLLOWED = new Set<ColdCause>(["empty", "diverged"]);

const REFUSED: Record<Refusal, ColdCause> = {
	[ERefusal.TooLarge]: "too-large",
	[ERefusal.TooManyDocs]: "too-many",
	[ERefusal.ReadOnly]: "read-only",
};

export interface LiveSessionsDeps {
	app: App;
	hub: Pick<HubConnection, "space">;
	/** Where the note goes live; null keeps it cold: live off, no key yet, a paused share. */
	liveSpace(path: string): Promise<LiveSpace | null>;
	agreed: AgreedTexts;
	/** The cold-sync baseline, the merge base for a note never agreed here. */
	baseText(path: string): Promise<string | null>;
	/** Renames a note as another device did; false when that cannot happen here. */
	moveFile(from: string, to: string): Promise<boolean>;
	/** Whether others' text is tinted by author. */
	authorsShown(): boolean;
	/** The name the relay vouches for a person present in a space. */
	nameOf(space: string, person: string): string | null;
}

interface Room extends LiveRoom {
	space: LiveSpace;
	editor: LiveEditor;
	/** Kept across a rename, so the room can tell its file moved. */
	file: TFile;
	/** The path its docIds are named by: the file's, until a rename here moves the room. */
	lineage: string;
	/** Where this device is moving the room. */
	renamingTo: string | null;
}

/** Where a room opens when a pointer named its generation: `successor` was filled by whoever moved it. */
interface OpenAt {
	lineage: string;
	generation: number;
	successor: boolean;
}

interface Binding {
	path: string;
	session: LiveSession;
	/** Whose text is left untinted: this device's person in the room's space. */
	person: string;
	editor: BoundEditor;
}

export class LiveSessions {
	private readonly rooms = new Map<string, Room>();
	private readonly bound = new Map<WorkspaceLeaf, Binding>();
	/** Open notes left to the file sync: their room moved elsewhere, or the hub cannot carry them. */
	private readonly cold = new Map<string, ColdCause>();
	private readonly listeners = new Set<() => void>();
	private running = false;
	private again = false;
	private disposed = false;
	/** A pass for views still loading: nothing announces when they are ready. */
	private retry: number | null = null;
	private patience: number | null = null;

	constructor(private readonly deps: LiveSessionsDeps) {}

	/** Coalesces: a refresh asked for mid-run runs once more after it. */
	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			do {
				this.again = false;
				await this.run();
			} while (this.again && !this.disposed);
		} finally {
			this.running = false;
		}
		this.notify();
		this.notifyWhenPatienceRunsOut();
	}

	/** Told after every refresh: a room joined, bound or left. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		if (this.retry !== null) window.clearTimeout(this.retry);
		if (this.patience !== null) window.clearTimeout(this.patience);
		this.listeners.clear();
		this.closeAll();
		void this.deps.agreed.flush();
	}

	/** The note's room once an editor is bound to it; null while closed, joining or moving. */
	roomOf(path: string): LiveSession | null {
		const room = this.rooms.get(path);
		const session = room?.session;
		// Moving, the room is still the old path's: the note's own answers from the new one.
		if (!session?.synced || room?.lineage !== path) return null;
		for (const binding of this.bound.values()) {
			if (binding.path === path) return session;
		}
		return null;
	}

	/** On its way to a room the hub can deliver; a dead hub or a silent room leaves the file to the sync. */
	joining(path: string): boolean {
		return this.waitedFor(path) === "patient";
	}

	/** The hub is up but the room stayed silent past the time it takes to answer. */
	unanswered(path: string): boolean {
		return this.waitedFor(path) === "silent";
	}

	/** The space whose room holds the note, open or joining; null while it is cold. */
	spaceOf(path: string): string | null {
		return this.rooms.get(path)?.space.id ?? null;
	}

	/** Why an open note was left to the file sync; null unless it was. */
	coldCause(path: string): ColdCause | null {
		return this.cold.get(path) ?? null;
	}

	/** Tints or clears every bound editor, as `authorsShown` now says. */
	repaintAuthors(): void {
		const shown = this.deps.authorsShown();
		for (const { person, editor } of this.bound.values()) {
			editor.showAuthors(shown ? person : null);
		}
	}

	/** Rebuilds an open note's room as its next generation, which everyone then follows. */
	async rotate(path: string): Promise<Rotation> {
		const room = this.roomOf(path);
		const entry = this.rooms.get(path);
		if (!room || entry?.lineage !== path) return "busy";
		return room.rotate(await docIdIn(entry.space, path, room.generation + 1));
	}

	/** Saves the note's bound editor now, so its file holds what the room has; false when nothing could. */
	async save(path: string): Promise<boolean> {
		const editor = this.rooms.get(path)?.editor;
		for (const [leaf, binding] of this.bound) {
			if (binding.path === path && editor) return editor.save(leaf.view);
		}
		return false;
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
		const shown = new Map(
			[...open.values()].map(({ file, space }) => [file.path, space]),
		);
		this.carryRenamed(shown);
		// A note that changed space (moved into a share, paused, new keys) leaves its old room.
		const stays = (path: string, room: Room): boolean => {
			const space = shown.get(path);
			return (
				space !== undefined &&
				sameSpace(space, room.space) &&
				room.session.movedTo === null &&
				!this.cold.has(path)
			);
		};

		for (const [leaf, binding] of this.bound) {
			const { path, session } = binding;
			const room = this.rooms.get(path);
			if (
				open.get(leaf)?.file.path === path &&
				room?.session === session &&
				stays(path, room) &&
				!binding.editor.stale?.()
			) {
				continue;
			}
			binding.editor.detach();
			this.bound.delete(leaf);
		}
		for (const [path, room] of [...this.rooms]) {
			if (stays(path, room)) continue;
			this.rooms.delete(path);
			room.session.dispose();
			const space = shown.get(path);
			const moved = room.session.movedTo !== null;
			if (moved && space && sameSpace(space, room.space)) {
				await this.follow(path, room);
			}
		}
		// Closed, a note tries again on its next open; a reader's also once they may write.
		for (const [path, cause] of this.cold) {
			const space = shown.get(path);
			if (!space || (UNFOLLOWED.has(cause) && !space.readOnly)) {
				this.cold.delete(path);
			}
		}
		if (this.disposed) return;

		for (const [leaf, { file, space, editor }] of open) {
			if (this.bound.has(leaf) || this.cold.has(file.path)) continue;
			const room =
				this.rooms.get(file.path) ?? (await this.open(file, space, editor));
			if (this.disposed || !room) return;
			// Binding before the room answered would publish this device's text as agreed.
			if (!room.session.synced) continue;
			if (room.editor.fileOf(leaf.view) !== file) continue;
			const { person } = space;
			const bound = room.bind(
				leaf.view,
				this.deps.authorsShown() ? person : null,
				() => void this.refresh(),
			);
			if (!bound) {
				this.retry ??= window.setTimeout(() => {
					this.retry = null;
					void this.refresh();
				}, LOADING_RETRY_MS);
				continue;
			}
			this.bound.set(leaf, {
				path: file.path,
				session: room.session,
				person,
				editor: bound,
			});
		}
	}

	/** A renamed file keeps its TFile: its room goes along and moves to the new path. */
	private carryRenamed(shown: Map<string, LiveSpace>): void {
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

	/**
	 * Opens the room a moved note continued in: its next generation, or the
	 * room it moved to with its file, which this file then follows. A pointer
	 * anywhere else would pour this note into another one's room.
	 */
	private async follow(path: string, from: Room): Promise<void> {
		const { session, space, editor, file, lineage } = from;
		const generation = session.generation + 1;
		const successor =
			session.movedTo === (await docIdIn(space, lineage, generation));
		const moved = successor ? null : await movedWith(space, session);
		if (!successor && !moved) {
			return this.goCold(path, "A live note moved to a room not its own.");
		}
		// Never in the room: a new note where one was renamed away, or a copy the file sync replaces.
		if (!moved || !session.joined) {
			await this.open(file, space, editor, { lineage, generation, successor });
			return;
		}
		const ours = moved.path === from.renamingTo || moved.path === path;
		if (!ours && !(await this.followRename(path, moved.path, space))) {
			return this.goCold(path, "A live note was renamed to a path taken here.");
		}
		// The base goes along; as at any open, the cold baseline when nothing was agreed.
		const base =
			(await this.deps.agreed.get(await docIdIn(space, lineage, 0)))?.text ??
			(await this.deps.baseText(lineage));
		if (base !== null) {
			const note = await docIdIn(space, moved.path, 0);
			this.deps.agreed.put(note, { text: base, gen: moved.generation, seq: 0 });
		}
		if (this.disposed) return;
		await this.open(file, space, editor, {
			lineage: moved.path,
			generation: moved.generation,
			successor: true,
		});
	}

	private async followRename(
		path: string,
		to: string,
		space: LiveSpace,
	): Promise<boolean> {
		const there = await this.deps.liveSpace(to);
		if (!there || !sameSpace(there, space)) return false;
		return this.deps.moveFile(path, to);
	}

	/** Leaves an open note to the file sync until it is closed. */
	private leave(path: string, cause: ColdCause): void {
		this.cold.set(path, cause);
		void this.refresh();
	}

	private goCold(path: string, why: string): void {
		reportWarning(why, path);
		this.cold.set(path, "moved-away");
	}

	private async open(
		file: TFile,
		space: LiveSpace,
		editor: LiveEditor,
		at?: OpenAt,
	): Promise<Room | null> {
		const { path } = file;
		const lineage = at?.lineage ?? path;
		const note = await docIdIn(space, lineage, 0);
		const { agreed, baseText, hub } = this.deps;
		const last = await agreed.get(note);
		const generation = at?.generation ?? last?.gen ?? 0;
		const docId =
			generation === 0 ? note : await docIdIn(space, lineage, generation);
		// Stepping past a room renamed away starts a new note: that room's text is no base for it.
		const fresh = at?.successor === false;
		await closedBefore(docId);
		// Unloaded meanwhile: a session opened now would never close.
		if (this.disposed) return null;
		const opened = editor.open(docId, generation, {
			keys: space.keys,
			hub: hub.space(space.id),
			author: { person: space.person, name: space.user.name },
			// A successor starts from its rebuild: empty, it lost its log like any room behind what was agreed.
			knownSeq: Math.max(
				last?.gen === generation ? last.seq : 0,
				at?.successor ? 1 : 0,
			),
			successor: () => docIdIn(space, lineage, generation + 1),
			readDisk: () => readOpen(this.deps.app, path, editor),
			readBase: async () =>
				(fresh ? null : (await agreed.get(note))?.text) ??
				(await baseText(path)) ??
				"",
			onAgreed: (text, seq) => agreed.put(note, { text, gen: generation, seq }),
			onMoved: () => void this.refresh(),
			onRefused: (reason) => this.leave(path, REFUSED[reason]),
			nameOf: (person) => this.deps.nameOf(space.id, person),
			...(space.readOnly
				? {
						follower: {
							unchanged: (disk: string) => this.known(note, path, disk),
							onCold: (why: Unfollowed) => this.leave(path, why),
						},
					}
				: {}),
		});
		opened.session.awareness.setLocalStateField("user", space.user);
		const room = { ...opened, space, editor, file, lineage, renamingTo: null };
		this.rooms.set(path, room);
		void opened.session.ready.then(() => this.refresh());
		return room;
	}

	/** A version the space already has, which a reader's view may show the room over. */
	private async known(
		note: string,
		path: string,
		disk: string,
	): Promise<boolean> {
		const lf = toLf(disk);
		const versions = [
			(await this.deps.agreed.get(note))?.text,
			await this.deps.baseText(path),
		];
		return versions.some(
			(text) => typeof text === "string" && toLf(text) === lf,
		);
	}

	private waitedFor(path: string): "patient" | "silent" | null {
		const room = this.rooms.get(path);
		if (
			!room ||
			this.roomOf(path) !== null ||
			!this.deps.hub.space(room.space.id).isConnected()
		) {
			return null;
		}
		if (room.lineage !== path) return "patient";
		const waited = Date.now() - room.session.subscribedAt;
		return waited < JOIN_PATIENCE_MS ? "patient" : "silent";
	}

	/** A joining room turns "unanswered" with no event of its own: look again once its patience is over. */
	private notifyWhenPatienceRunsOut(): void {
		const waiting = [...this.rooms.keys()].some((path) => this.joining(path));
		if (this.patience !== null || !waiting) return;
		this.patience = window.setTimeout(() => {
			this.patience = null;
			this.notify();
		}, JOIN_PATIENCE_MS);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private closeAll(): void {
		for (const { editor } of this.bound.values()) editor.detach();
		this.bound.clear();
		for (const { session } of this.rooms.values()) session.dispose();
		this.rooms.clear();
		this.cold.clear();
	}
}
