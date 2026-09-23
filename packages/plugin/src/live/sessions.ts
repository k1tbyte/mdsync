/**
 * Which notes are live: a session exists while its note is open in a
 * source-mode editor on this device, and every such leaf is bound to it once
 * the room answered. A room that moved hands its leaves to its successor.
 * Closed notes are the cold layer's business.
 */

import { OWNER } from "@obsync/protocol";
import {
	type App,
	MarkdownView,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";

import type { LiveKeys } from "@/crypto/live-keys";
import type { HubConnection } from "@/hub/connection";
import { reportWarning } from "@/shared/diagnostics";

import type { AgreedTexts } from "./agreed-texts";
import { bindEditor } from "./binding";
import { isLiveDocument } from "./doc-types";
import { docIdFor } from "./seal";
import { LiveSession, type Rotation } from "./session";

export interface LiveUser {
	name: string;
	color: string;
	colorLight: string;
}

export interface LiveSessionsDeps {
	app: App;
	hub: Pick<HubConnection, "send" | "isConnected" | "listen">;
	/** Null while live editing cannot run: switched off, or no key resolved yet. */
	keys(): Promise<LiveKeys | null>;
	user(): LiveUser;
	agreed: AgreedTexts;
	/** The cold-sync baseline, the merge base for a note never agreed here. */
	baseText(path: string): Promise<string | null>;
}

interface Binding {
	path: string;
	session: LiveSession;
	detach(): void;
}

export class LiveSessions {
	private keys: LiveKeys | null = null;
	private readonly sessions = new Map<string, LiveSession>();
	private readonly bound = new Map<WorkspaceLeaf, Binding>();
	/** Open notes whose room moved somewhere that is not their next generation. */
	private readonly stranded = new Set<string>();
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
	}

	dispose(): void {
		this.disposed = true;
		this.closeAll();
		void this.deps.agreed.flush();
	}

	/** The note's room once an editor is bound to it; null while closed, joining or moving. */
	roomOf(path: string): LiveSession | null {
		const session = this.sessions.get(path);
		if (!session?.synced) return null;
		for (const binding of this.bound.values()) {
			if (binding.path === path) return session;
		}
		return null;
	}

	/** Open here and on its way to a room the hub can deliver; a dead hub leaves the file to the sync. */
	joining(path: string): boolean {
		return (
			this.sessions.has(path) &&
			this.roomOf(path) === null &&
			this.deps.hub.isConnected()
		);
	}

	/** Rebuilds an open note's room as its next generation, which everyone then follows. */
	async rotate(path: string): Promise<Rotation> {
		const room = this.roomOf(path);
		if (!room || !this.keys) return "busy";
		return room.rotate(await docIdFor(this.keys, path, room.generation + 1));
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
		const keys = await this.deps.keys();
		if (this.disposed) return;
		// New keys name every document anew: nothing open may keep its old room.
		if (keys !== this.keys) {
			this.closeAll();
			this.keys = keys;
		}
		const open = keys ? this.openEditors() : new Map<WorkspaceLeaf, TFile>();

		for (const [leaf, binding] of this.bound) {
			const { path, session } = binding;
			if (open.get(leaf)?.path === path && session.movedTo === null) continue;
			binding.detach();
			this.bound.delete(leaf);
		}
		const shown = new Set([...open.values()].map((file) => file.path));
		for (const [path, session] of [...this.sessions]) {
			if (shown.has(path) && session.movedTo === null) continue;
			this.sessions.delete(path);
			session.dispose();
			if (keys && shown.has(path)) await this.follow(path, session, keys);
		}
		for (const path of this.stranded) {
			if (!shown.has(path)) this.stranded.delete(path);
		}
		if (!keys || this.disposed || keys !== this.keys) return;

		for (const [leaf, file] of open) {
			if (this.bound.has(leaf) || this.stranded.has(file.path)) continue;
			const session =
				this.sessions.get(file.path) ?? (await this.open(file.path, keys));
			if (this.disposed || keys !== this.keys) return;
			// Binding before the room answered would publish this device's text as agreed.
			if (!session.synced) continue;
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file !== file) continue;
			this.bound.set(leaf, {
				path: file.path,
				session,
				detach: bindEditor(view, session),
			});
		}
	}

	/**
	 * Opens the room a moved note continued in. A pointer anywhere but its next
	 * generation would pour this note into another one's room.
	 */
	private async follow(
		path: string,
		from: LiveSession,
		keys: LiveKeys,
	): Promise<void> {
		const generation = from.generation + 1;
		if (from.movedTo !== (await docIdFor(keys, path, generation))) {
			reportWarning("A live note moved to a room that is not its own.", path);
			this.stranded.add(path);
			return;
		}
		if (this.disposed || keys !== this.keys) return;
		this.sessions.set(path, await this.open(path, keys, generation));
	}

	/** `follows`: the generation a moved room pointed at, which is never seeded from disk. */
	private async open(
		path: string,
		keys: LiveKeys,
		follows?: number,
	): Promise<LiveSession> {
		const note = await docIdFor(keys, path, 0);
		const { agreed, baseText, hub } = this.deps;
		const generation = follows ?? (await agreed.get(note))?.gen ?? 0;
		const docId =
			generation === 0 ? note : await docIdFor(keys, path, generation);
		const session = new LiveSession(docId, generation, {
			keys,
			hub,
			person: OWNER,
			follower: follows !== undefined,
			readDisk: () => this.readDisk(path),
			readBase: async () =>
				(await agreed.get(note))?.text ?? (await baseText(path)) ?? "",
			onAgreed: (text, seq) => agreed.put(note, { text, gen: generation, seq }),
			onMoved: () => void this.refresh(),
		});
		session.awareness.setLocalStateField("user", this.deps.user());
		this.sessions.set(path, session);
		void session.ready.then(() => this.refresh());
		return session;
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

	private openEditors(): Map<WorkspaceLeaf, TFile> {
		const open = new Map<WorkspaceLeaf, TFile>();
		for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.getMode() !== "source") {
				continue;
			}
			if (view.file && isLiveDocument(this.deps.app, view.file)) {
				open.set(leaf, view.file);
			}
		}
		return open;
	}

	private closeAll(): void {
		for (const binding of this.bound.values()) binding.detach();
		this.bound.clear();
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
		this.stranded.clear();
	}
}
