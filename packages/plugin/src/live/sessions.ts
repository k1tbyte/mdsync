/**
 * Which files are live: a session exists while its file is open in a view
 * that edits it live on this device (a note in source mode, a drawing in
 * Excalidraw), and every such leaf is bound to it once the room answered. A
 * room that moved hands its leaves to its successor. Closed files are the
 * cold layer's business.
 */

import type { App, TFile, WorkspaceLeaf } from "obsidian";

import type { HubConnection } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";

import type { AgreedTexts } from "./agreed-texts";
import { liveKindOf } from "./doc-types";
import { EDITORS, type LiveEditor, type LiveRoom } from "./editors";
import type { BoundEditor } from "./model";
import type { LiveSession, Rotation } from "./session";
import { docIdIn, type LiveSpace, sameSpace } from "./space";

const LOADING_RETRY_MS = 500;

export interface LiveSessionsDeps {
	app: App;
	hub: Pick<HubConnection, "space">;
	/** Where the note goes live; null keeps it cold: live off, no key yet, a paused or read-only share. */
	liveSpace(path: string): Promise<LiveSpace | null>;
	agreed: AgreedTexts;
	/** The cold-sync baseline, the merge base for a note never agreed here. */
	baseText(path: string): Promise<string | null>;
}

interface Room extends LiveRoom {
	space: LiveSpace;
	editor: LiveEditor;
}

interface OpenNote {
	file: TFile;
	space: LiveSpace;
	editor: LiveEditor;
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
	/** Open notes whose room moved somewhere that is not their next generation. */
	private readonly stranded = new Set<string>();
	private readonly listeners = new Set<() => void>();
	/** Who typed what, tinted in every bound editor; this app session only. */
	private authors = false;
	private running = false;
	private again = false;
	private disposed = false;
	/** A pass for views still loading: nothing announces when they are ready. */
	private retry: number | null = null;

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
		for (const listener of this.listeners) listener();
	}

	/** Told after every refresh: a room joined, bound or left. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		if (this.retry !== null) window.clearTimeout(this.retry);
		this.listeners.clear();
		this.closeAll();
		void this.deps.agreed.flush();
	}

	/** The note's room once an editor is bound to it; null while closed, joining or moving. */
	roomOf(path: string): LiveSession | null {
		const session = this.rooms.get(path)?.session;
		if (!session?.synced) return null;
		for (const binding of this.bound.values()) {
			if (binding.path === path) return session;
		}
		return null;
	}

	/** Open here and on its way to a room the hub can deliver; a dead hub leaves the file to the sync. */
	joining(path: string): boolean {
		const room = this.rooms.get(path);
		return (
			room !== undefined &&
			this.roomOf(path) === null &&
			this.deps.hub.space(room.space.id).isConnected()
		);
	}

	/** The space whose room holds the note, open or joining; null while it is cold. */
	spaceOf(path: string): string | null {
		return this.rooms.get(path)?.space.id ?? null;
	}

	/** Returns whether authors are now shown. */
	toggleAuthors(): boolean {
		this.authors = !this.authors;
		for (const { person, editor } of this.bound.values()) {
			editor.showAuthors(this.authors ? person : null);
		}
		return this.authors;
	}

	/** Rebuilds an open note's room as its next generation, which everyone then follows. */
	async rotate(path: string): Promise<Rotation> {
		const room = this.roomOf(path);
		const space = this.rooms.get(path)?.space;
		if (!room || !space) return "busy";
		return room.rotate(await docIdIn(space, path, room.generation + 1));
	}

	/** Saves the note's bound editor now, so its file holds what the room has. */
	async save(path: string): Promise<void> {
		const editor = this.rooms.get(path)?.editor;
		for (const [leaf, binding] of this.bound) {
			if (binding.path !== path || !editor) continue;
			await editor.save(leaf.view);
			return;
		}
	}

	private async run(): Promise<void> {
		const open = await this.openEditors();
		if (this.disposed) return;
		const shown = new Map(
			[...open.values()].map(({ file, space }) => [file.path, space]),
		);
		// A note that changed space (moved into a share, paused, new keys) leaves its old room.
		const stays = (path: string, room: Room): boolean => {
			const space = shown.get(path);
			return (
				space !== undefined &&
				sameSpace(space, room.space) &&
				room.session.movedTo === null
			);
		};

		for (const [leaf, binding] of this.bound) {
			const { path, session } = binding;
			const room = this.rooms.get(path);
			if (
				open.get(leaf)?.file.path === path &&
				room?.session === session &&
				stays(path, room)
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
			if (space && sameSpace(space, room.space)) await this.follow(path, room);
		}
		for (const path of this.stranded) {
			if (!shown.has(path)) this.stranded.delete(path);
		}
		if (this.disposed) return;

		for (const [leaf, { file, space, editor }] of open) {
			if (this.bound.has(leaf) || this.stranded.has(file.path)) continue;
			const room =
				this.rooms.get(file.path) ??
				(await this.open(file.path, space, editor));
			if (this.disposed) return;
			// Binding before the room answered would publish this device's text as agreed.
			if (!room.session.synced) continue;
			if (room.editor.fileOf(leaf.view) !== file) continue;
			const { person } = space;
			const bound = room.bind(leaf.view, this.authors ? person : null);
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

	/**
	 * Opens the room a moved note continued in. A pointer anywhere but its next
	 * generation would pour this note into another one's room.
	 */
	private async follow(path: string, from: Room): Promise<void> {
		const generation = from.session.generation + 1;
		if (
			from.session.movedTo !== (await docIdIn(from.space, path, generation))
		) {
			reportWarning("A live note moved to a room that is not its own.", path);
			this.stranded.add(path);
			return;
		}
		if (this.disposed) return;
		await this.open(path, from.space, from.editor, generation);
	}

	/** `follows`: the generation a moved room pointed at, which is never seeded from disk. */
	private async open(
		path: string,
		space: LiveSpace,
		editor: LiveEditor,
		follows?: number,
	): Promise<Room> {
		const note = await docIdIn(space, path, 0);
		const { agreed, baseText, hub } = this.deps;
		const generation = follows ?? (await agreed.get(note))?.gen ?? 0;
		const docId =
			generation === 0 ? note : await docIdIn(space, path, generation);
		const opened = editor.open(docId, generation, {
			keys: space.keys,
			hub: hub.space(space.id),
			author: { person: space.person, name: space.user.name },
			follower: follows !== undefined,
			readDisk: () => this.readDisk(path, editor),
			readBase: async () =>
				(await agreed.get(note))?.text ?? (await baseText(path)) ?? "",
			onAgreed: (text, seq) => agreed.put(note, { text, gen: generation, seq }),
			onMoved: () => void this.refresh(),
		});
		opened.session.awareness.setLocalStateField("user", space.user);
		const room = { ...opened, space, editor };
		this.rooms.set(path, room);
		void opened.session.ready.then(() => this.refresh());
		return room;
	}

	/** An open view is newer than the file it saves a moment later. */
	private async readDisk(path: string, editor: LiveEditor): Promise<string> {
		const { workspace, vault } = this.deps.app;
		for (const leaf of workspace.getLeavesOfType(editor.viewType)) {
			const text = editor.read(leaf.view, path);
			if (text !== null) return text;
		}
		const file = vault.getFileByPath(path);
		return file ? vault.read(file) : "";
	}

	private async openEditors(): Promise<Map<WorkspaceLeaf, OpenNote>> {
		const { app, liveSpace } = this.deps;
		const open = new Map<WorkspaceLeaf, OpenNote>();
		for (const [kind, editor] of Object.entries(EDITORS)) {
			for (const leaf of app.workspace.getLeavesOfType(editor.viewType)) {
				const file = editor.fileOf(leaf.view);
				if (!file || liveKindOf(app, file) !== kind) continue;
				const space = await liveSpace(file.path);
				if (space) open.set(leaf, { file, space, editor });
			}
		}
		return open;
	}

	private closeAll(): void {
		for (const { editor } of this.bound.values()) editor.detach();
		this.bound.clear();
		for (const { session } of this.rooms.values()) session.dispose();
		this.rooms.clear();
		this.stranded.clear();
	}
}
