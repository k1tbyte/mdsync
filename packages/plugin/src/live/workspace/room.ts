import { ERefusal } from "@obsync/protocol";
import type { App, TFile } from "obsidian";

import type { HubConnection } from "@/hub";
import type { AgreedTexts } from "@/live/cold/agreed-texts";
import { closedBefore } from "@/live/session";
import type { Refused, Unfollowed } from "@/live/session/session-deps";
import { reportWarning, withDevices } from "@/shared";
import { toLf } from "@/utils";
import { type LiveEditor, type LiveRoom, readOpen } from "./editors";
import { type MoveNote, movedWith } from "./rename";
import { docIdIn, type LiveSpace, sameSpace } from "./space";

/** Why an open note stays cold until it is closed. */
export type ColdCause =
	| "moved-away"
	| "too-large"
	| "too-many"
	| "read-only"
	| "unreadable"
	| Unfollowed;

const REFUSED: Record<Refused, ColdCause> = {
	[ERefusal.TooLarge]: "too-large",
	[ERefusal.TooManyDocs]: "too-many",
	[ERefusal.ReadOnly]: "read-only",
	unreadable: "unreadable",
};

export interface Room extends LiveRoom {
	space: LiveSpace;
	editor: LiveEditor;
	/** Kept across a rename, so the room can tell its file moved. */
	file: TFile;
	/** The path its docIds are named by: the file's, until a rename here moves the room. */
	lineage: string;
	renamingTo: string | null;
}

/** Where a room opens when a pointer named its generation: `successor` was filled by whoever moved it. */
export interface OpenAt {
	lineage: string;
	generation: number;
	successor: boolean;
}

export interface RoomDeps {
	app: App;
	hub: Pick<HubConnection, "space">;
	/** Where the note goes live; null keeps it cold: live off, no key yet, a paused share. */
	liveSpace(path: string): Promise<LiveSpace | null>;
	agreed: AgreedTexts;
	/** The cold-sync baseline, the merge base for a note never agreed here. */
	baseText(path: string): Promise<string | null>;
	/** Renames a note as another device did; false when that cannot happen here. */
	moveFile(from: string, to: string): Promise<boolean>;
	/** The name the relay vouches for a person present in a space. */
	nameOf(space: string, person: string): string | null;
}

export interface RoomHooks {
	alive(): boolean;
	refresh(): void;
	leave(path: string, cause: ColdCause): void;
}

export class RoomOpener {
	constructor(
		private readonly deps: RoomDeps,
		private readonly hooks: RoomHooks,
	) {}

	async open(
		file: TFile,
		space: LiveSpace,
		editor: LiveEditor,
		at?: OpenAt,
	): Promise<Room | null> {
		const { path } = file;
		const { agreed, baseText, hub } = this.deps;
		const lineage = at?.lineage ?? path;
		const note = await docIdIn(space, lineage, 0);
		const last = await agreed.get(note);
		const generation = at?.generation ?? last?.gen ?? 0;
		const docId =
			generation === 0 ? note : await docIdIn(space, lineage, generation);
		// Stepping past a room renamed away starts a new note: that room's text is no base for it.
		const fresh = at?.successor === false;
		await closedBefore(docId);
		// Unloaded meanwhile: a session opened now would never close.
		if (!this.hooks.alive()) return null;
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
				(fresh ? null : await agreed.base(note)) ??
				(await baseText(path)) ??
				"",
			onAgreed: (text, seq) =>
				agreed.put(note, { text, gen: generation, seq }, () =>
					this.saved(file, editor, text),
				),
			onMoved: () => this.hooks.refresh(),
			onRefused: (reason) => this.hooks.leave(path, REFUSED[reason]),
			nameOf: (person) => this.deps.nameOf(space.id, person),
			follower: space.readOnly
				? {
						unchanged: (disk) => this.known(note, path, disk),
						onCold: (why) => this.hooks.leave(path, why),
					}
				: undefined,
		});
		const { key, name, color, device } = space.user;
		opened.session.awareness.setLocalStateField("user", {
			key,
			color,
			name: withDevices(name, device ? [device] : []),
		});
		void opened.session.ready.then(() => this.hooks.refresh());
		return { ...opened, space, editor, file, lineage, renamingTo: null };
	}

	/**
	 * Where a moved note continues: its next generation or the room it moved to with its file (anywhere
	 * else would pour it into another's room); null leaves it to the file sync.
	 */
	async follow(path: string, from: Room): Promise<OpenAt | null> {
		const { session, space, lineage } = from;
		const generation = session.generation + 1;
		const successor =
			session.movedTo === (await docIdIn(space, lineage, generation));
		const moved = successor ? null : await movedWith(space, session);
		if (!successor && !moved) {
			reportWarning("A live note moved to a room not its own.", path);
			return null;
		}
		// Never in the room: a new note where one was renamed away, or a copy the file sync replaces.
		if (!moved || !session.joined) return { lineage, generation, successor };
		const ours = moved.path === from.renamingTo || moved.path === path;
		if (!ours && !(await this.followRename(path, moved.path, space))) {
			reportWarning("A live note was renamed to a path taken here.", path);
			return null;
		}
		await this.carryBase(space, lineage, moved);
		return {
			lineage: moved.path,
			generation: moved.generation,
			successor: true,
		};
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

	/** The base goes along; as at any open, the cold baseline when nothing was agreed. */
	private async carryBase(
		space: LiveSpace,
		lineage: string,
		moved: MoveNote,
	): Promise<void> {
		const { agreed, baseText } = this.deps;
		const base =
			(await agreed.base(await docIdIn(space, lineage, 0))) ??
			(await baseText(lineage));
		if (base === null) return;
		const note = await docIdIn(space, moved.path, 0);
		agreed.put(note, { text: base, gen: moved.generation, seq: 0 });
	}

	/** Whether the file holds `agreed` yet: the view saves it a moment later. */
	private async saved(
		file: TFile,
		editor: LiveEditor,
		agreed: string,
	): Promise<boolean> {
		try {
			return editor.holds(agreed, await this.deps.app.vault.cachedRead(file));
		} catch {
			return false;
		}
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
}
