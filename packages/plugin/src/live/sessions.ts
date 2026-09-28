/**
 * Which notes are live: a session exists while its note is open in a
 * source-mode editor on this device, and every such leaf is bound to it once
 * the room answered. A room that moved hands its leaves to its successor.
 * Closed notes are the cold layer's business.
 */

import {
	type App,
	MarkdownView,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";

import type { HubConnection } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";

import type { AgreedTexts } from "./agreed-texts";
import { type BoundEditor, bindEditor } from "./binding";
import { isLiveDocument } from "./doc-types";
import { LiveSession, type Rotation } from "./session";
import { docIdIn, type LiveSpace, sameSpace } from "./space";

export interface LiveSessionsDeps {
	app: App;
	hub: Pick<HubConnection, "space">;
	/** Where the note goes live; null keeps it cold: live off, no key yet, a paused or read-only share. */
	liveSpace(path: string): Promise<LiveSpace | null>;
	agreed: AgreedTexts;
	/** The cold-sync baseline, the merge base for a note never agreed here. */
	baseText(path: string): Promise<string | null>;
}

interface Room {
	session: LiveSession;
	space: LiveSpace;
}

interface OpenNote {
	file: TFile;
	space: LiveSpace;
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
		for (const [leaf, binding] of this.bound) {
			if (binding.path !== path || !(leaf.view instanceof MarkdownView)) {
				continue;
			}
			await leaf.view.save();
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

		for (const [leaf, { file, space }] of open) {
			if (this.bound.has(leaf) || this.stranded.has(file.path)) continue;
			const { session } =
				this.rooms.get(file.path) ?? (await this.open(file.path, space));
			if (this.disposed) return;
			// Binding before the room answered would publish this device's text as agreed.
			if (!session.synced) continue;
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file !== file) continue;
			const { person } = space;
			this.bound.set(leaf, {
				path: file.path,
				session,
				person,
				editor: bindEditor(view, session, this.authors ? person : null),
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
		await this.open(path, from.space, generation);
	}

	/** `follows`: the generation a moved room pointed at, which is never seeded from disk. */
	private async open(
		path: string,
		space: LiveSpace,
		follows?: number,
	): Promise<Room> {
		const note = await docIdIn(space, path, 0);
		const { agreed, baseText, hub } = this.deps;
		const generation = follows ?? (await agreed.get(note))?.gen ?? 0;
		const docId =
			generation === 0 ? note : await docIdIn(space, path, generation);
		const session = new LiveSession(docId, generation, {
			keys: space.keys,
			hub: hub.space(space.id),
			author: { person: space.person, name: space.user.name },
			follower: follows !== undefined,
			readDisk: () => this.readDisk(path),
			readBase: async () =>
				(await agreed.get(note))?.text ?? (await baseText(path)) ?? "",
			onAgreed: (text, seq) => agreed.put(note, { text, gen: generation, seq }),
			onMoved: () => void this.refresh(),
		});
		session.awareness.setLocalStateField("user", space.user);
		const room = { session, space };
		this.rooms.set(path, room);
		void session.ready.then(() => this.refresh());
		return room;
	}

	/** An open editor is newer than the file it saves a moment later. */
	private async readDisk(path: string): Promise<string> {
		const { workspace, vault } = this.deps.app;
		for (const leaf of workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) {
				return view.editor.getValue();
			}
		}
		const file = vault.getFileByPath(path);
		return file ? vault.read(file) : "";
	}

	private async openEditors(): Promise<Map<WorkspaceLeaf, OpenNote>> {
		const open = new Map<WorkspaceLeaf, OpenNote>();
		for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== "source") {
				continue;
			}
			const file = view.file;
			if (!file || !isLiveDocument(this.deps.app, file)) continue;
			const space = await this.deps.liveSpace(file.path);
			if (space) open.set(leaf, { file, space });
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
