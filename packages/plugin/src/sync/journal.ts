/**
 * The engine's content writes, from before they start until they land. Obsidian truncates before it writes, so
 * one cut short leaves a prefix of the new content; its staged copy lets the next compare finish it
 * (`cut-short.ts`) instead of reading an edit there, merging it and pushing it.
 */

import type { DataAdapter } from "obsidian";
import { PLUGIN_ID } from "@/constants";
import { randomId, sha256Hex } from "@/crypto";
import { writeAtomic } from "@/vault/atomic-write";
import { ensureParent, readBinary, writeBinary } from "@/vault/io";
import { insideOf, type Space, spaceOf, vaultPathOf } from "./space";
import type { LiveMark, ManifestEntry } from "./types";

/** What the baseline of the storage and vault it was claimed under takes once a download is finished on recovery. */
export interface BaseStep {
	entry: ManifestEntry;
	/** The baseline's hash then: one that moved since outdates the step. */
	from?: string;
	storage: string;
	vaultId: string;
}

/** What a write puts down. */
export interface Target {
	hash: string;
	/** A marked version: its room learns of it once it is on disk. */
	live?: LiveMark;
	base?: BaseStep;
}

export interface Intent extends Target {
	space: string;
	/** The space's root when claimed: a share moved since re-roots the path. */
	root: string;
	/** Names its staged copy, whole before the destination is touched. */
	copy: string;
	/** Finished on recovery: held only until its base step is saved. */
	landed?: true;
}

/** A batch's claims: a path left out is new, written as is. */
export type Claims = ReadonlyMap<string, Intent>;

export class UnfinishedWriteError extends Error {
	override readonly name = "UnfinishedWriteError";

	constructor(path: string) {
		super(
			`"${path}" is still being restored after an interrupted sync. Refresh, then try again.`,
		);
	}
}

export class WriteJournal {
	private readonly intents: Map<string, Intent>;
	/** Cut short here or before a restart: the disk may hold part of it. */
	private readonly interrupted: Set<Intent>;
	private readonly file: string;
	private readonly stagingDir: string;
	private dirty = false;
	private saving: Promise<void> = Promise.resolve();
	/** Unloaded: an operation still running, its state save dropped, must not shrink the next instance's file. */
	private disposed = false;

	constructor(
		private readonly adapter: DataAdapter,
		configDir: string,
		intents: Record<string, Intent> = {},
	) {
		const dir = `${configDir.replace(/\/$/, "")}/plugins/${PLUGIN_ID}`;
		this.file = `${dir}/journal.json`;
		this.stagingDir = `${dir}/staging`;
		this.intents = new Map(Object.entries(intents));
		this.interrupted = new Set(this.intents.values());
	}

	/** Throws while the file cannot be read: read as empty, the writes it holds would pass for edits. */
	static async load(
		adapter: DataAdapter,
		configDir: string,
	): Promise<WriteJournal> {
		let journal = new WriteJournal(adapter, configDir);
		for (const path of [
			journal.file,
			`${journal.file}.new`,
			`${journal.file}.bak`,
		]) {
			// Mobile `exists()` is false on any error.
			if ((await adapter.stat(path)) === null) continue;
			const raw = await adapter.read(path);
			try {
				journal = new WriteJournal(
					adapter,
					configDir,
					JSON.parse(raw) as Record<string, Intent>,
				);
				break;
			} catch {
				// Garbled: the next copy, as `loadState` reads them.
			}
		}
		await journal.prune();
		return journal;
	}

	/** Durable before any is written; refused whole while an unfinished write holds one of the paths. */
	async claim(
		space: Space,
		targets: ReadonlyMap<string, Target>,
	): Promise<Map<string, Intent>> {
		// Its save is dropped too: no claim is durable.
		if (this.disposed)
			throw new Error("Sync stopped: the plugin was unloaded.");
		const held = new Set([
			...this.intents.keys(),
			...this.pending(space).map(({ path }) => path),
		]);
		const taken = [...targets.keys()].find((path) => held.has(path));
		if (taken !== undefined) throw new UnfinishedWriteError(taken);
		const claimed = new Map<string, Intent>();
		for (const [path, target] of targets) {
			const intent = {
				...target,
				space: space.id,
				root: space.root,
				copy: randomId(),
			};
			this.intents.set(path, intent);
			claimed.set(path, intent);
		}
		if (claimed.size === 0) return claimed;
		this.dirty = true;
		try {
			await this.save();
		} catch (err) {
			for (const [path, intent] of claimed) this.drop(path, intent);
			throw err;
		}
		return claimed;
	}

	/**
	 * False, writing nothing, when `ready` says no once the copy is staged: an edit saved meanwhile stays.
	 * `landed` ends the write: no room opens on the file before, and failed it leaves the write cut short.
	 * One with a base step stays until its operation saves the baseline (`acknowledge`).
	 */
	async write(
		path: string,
		intent: Intent,
		bytes: Uint8Array,
		ready?: () => Promise<boolean>,
		landed?: () => Promise<void>,
	): Promise<boolean> {
		try {
			await writeBinary(this.adapter, this.copyPath(intent), bytes);
			if (ready && !(await ready())) {
				await this.release(path, intent);
				return false;
			}
			await writeBinary(this.adapter, path, bytes);
			await landed?.();
		} catch (err) {
			this.interrupted.add(intent);
			throw err;
		}
		if (intent.base) await this.land(intent);
		else await this.release(path, intent);
		return true;
	}

	/** "cut" when the file at `path` may hold part of an engine write, "writing" while one is under way. */
	writeAt(space: Space, path: string): "cut" | "writing" | null {
		const write = this.pending(space).find((each) => each.path === path);
		if (!write || write.intent.landed) return null;
		return this.interrupted.has(write.intent) ? "cut" : "writing";
	}

	/** On disk whole, its room's merge base saved: kept only for its base step, never rewritten. */
	async land(intent: Intent): Promise<void> {
		intent.landed = true;
		this.dirty = true;
		await this.adapter.remove(this.copyPath(intent)).catch(() => undefined);
	}

	/** Once the baseline holding their steps is saved: the space's finished writes go. */
	async acknowledge(space: Space): Promise<void> {
		for (const { key, intent } of this.pending(space)) {
			if (intent.landed) await this.release(key, intent);
		}
		// Kept on disk, they are judged again by the baseline they gave.
		await this.save().catch(() => undefined);
	}

	/** Some write was cut short, here or before a restart, and waits for a refresh. */
	hasCutShort(): boolean {
		return this.interrupted.size > 0;
	}

	/** Each of the space's writes at its file's path now: a share moved since took its files along. */
	pending(space: Space): { path: string; key: string; intent: Intent }[] {
		return [...this.intents]
			.filter(([, intent]) => intent.space === space.id)
			.map(([key, intent]) => ({
				path: vaultPathOf(space, insideOf(intent, key)),
				key,
				intent,
			}));
	}

	/** Follows each write to where its space has it now, and to the space holding that path: a share opened or closed. */
	adopt(partition: readonly Space[]): void {
		for (const [key, intent] of [...this.intents]) {
			const space = partition.find(({ id }) => id === intent.space);
			// Kept at its path now, so a share closed after a move hands on the right one.
			const path = space ? vaultPathOf(space, insideOf(intent, key)) : key;
			const owner = spaceOf(partition, path);
			if (owner.id === intent.space && owner.root === intent.root) continue;
			this.intents.delete(key);
			this.intents.set(path, intent);
			intent.space = owner.id;
			intent.root = owner.root;
			this.dirty = true;
		}
	}

	/** Null when staging never finished, so the destination was never touched; a copy unread throws. */
	async staged(intent: Intent): Promise<Uint8Array | null> {
		const copy = this.copyPath(intent);
		// Mobile `exists()` is false on any error; `stat` is null only when it is missing.
		if ((await this.adapter.stat(copy)) === null) return null;
		const bytes = await readBinary(this.adapter, copy);
		return (await sha256Hex(bytes)) === intent.hash ? bytes : null;
	}

	/** Landed, finished or never started. Saved with the next save. */
	async release(path: string, intent: Intent): Promise<void> {
		if (!this.drop(path, intent)) return;
		await this.adapter.remove(this.copyPath(intent)).catch(() => undefined);
	}

	/** After its batch: what was left alone or never reached goes, a write cut short or landed stays. */
	async settle(claims: Claims): Promise<void> {
		for (const [path, intent] of claims) {
			if (!this.interrupted.has(intent) && !intent.landed) {
				await this.release(path, intent);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	save(): Promise<void> {
		// A failed save must not fail every later one.
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				if (!this.dirty || this.disposed) return;
				this.dirty = false;
				try {
					await ensureParent(this.adapter, this.file);
					await writeAtomic(
						this.adapter,
						this.file,
						JSON.stringify(Object.fromEntries(this.intents)),
					);
				} catch (err) {
					this.dirty = true;
					throw err;
				}
			});
		return this.saving;
	}

	/** Copies no write names: one whose removal failed would stay for good. */
	private async prune(): Promise<void> {
		const named = new Set(
			[...this.intents.values()].map((intent) => this.copyPath(intent)),
		);
		const listed = await this.adapter.list(this.stagingDir).catch(() => null);
		for (const file of listed?.files ?? []) {
			if (!named.has(file))
				await this.adapter.remove(file).catch(() => undefined);
		}
	}

	private drop(path: string, intent: Intent): boolean {
		if (this.intents.get(path) !== intent) return false;
		this.intents.delete(path);
		this.interrupted.delete(intent);
		this.dirty = true;
		return true;
	}

	private copyPath(intent: Intent): string {
		return `${this.stagingDir}/${intent.copy}`;
	}
}
