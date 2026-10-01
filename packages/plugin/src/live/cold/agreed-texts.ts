/**
 * Per note (by its first docId), the text its room last agreed on: its merge base and generation when it
 * reopens. Kept in the plugin folder, which never syncs; a lost file falls back to the sync baseline.
 */

import type { DataAdapter } from "obsidian";

import { PLUGIN_ID } from "@/constants";
import { reportWarning } from "@/shared";
import { ensureDir } from "@/vault/io";

export interface AgreedText {
	text: string;
	gen: number;
	seq: number;
}

/** Whether the note's file holds the text yet: a base ahead of it would undo the rest on the next open. */
export type OnDisk = () => Promise<boolean>;

interface Unwritten {
	agreed: AgreedText;
	onDisk?: OnDisk;
	tries: number;
}

/** Typing agrees several times a second; the disk hears about it at most this often. */
const WRITE_DELAY_MS = 2_000;
/** A file saves a moment after its room agrees; one that never does (a reader's) stops being asked. */
const MAX_TRIES = 5;
const MAX_KEPT = 500;

export class AgreedTexts {
	private readonly dir: string;
	private readonly unwritten = new Map<string, Unwritten>();
	private timer: number | null = null;
	private disposed = false;
	private writing: Promise<void> = Promise.resolve();
	/** Listed once: most notes never went live, and each would cost a failed read. */
	private stored: Promise<Set<string>> | null = null;

	constructor(
		private readonly adapter: DataAdapter,
		configDir: string,
	) {
		this.dir = `${configDir.replace(/\/$/, "")}/plugins/${PLUGIN_ID}/live`;
	}

	/** The latest agreement, saved to the note's file or not. */
	async get(docId: string): Promise<AgreedText | null> {
		return this.unwritten.get(docId)?.agreed ?? this.read(docId);
	}

	/** The merge base: one ahead of the note's file would undo the rest on open. */
	async base(docId: string): Promise<string | null> {
		const unwritten = this.unwritten.get(docId);
		if (unwritten && (await onDisk(unwritten))) return unwritten.agreed.text;
		return (await this.read(docId))?.text ?? null;
	}

	private async read(docId: string): Promise<AgreedText | null> {
		if (!(await this.files()).has(this.pathOf(docId))) return null;
		try {
			const parsed: unknown = JSON.parse(
				await this.adapter.read(this.pathOf(docId)),
			);
			return isAgreedText(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	/** No note ever agreed here: most vaults never go live. */
	async none(): Promise<boolean> {
		return this.unwritten.size === 0 && (await this.files()).size === 0;
	}

	/** Without `onDisk` the file holds it already. */
	put(docId: string, agreed: AgreedText, onDisk?: OnDisk): void {
		this.unwritten.set(docId, { agreed, onDisk, tries: 0 });
		this.schedule();
	}

	flush(): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.writing = this.writing.then(() => this.writeUnwritten());
		return this.writing;
	}

	dispose(): Promise<void> {
		this.disposed = true;
		return this.flush();
	}

	private schedule(): void {
		if (this.disposed) return;
		this.timer ??= window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, WRITE_DELAY_MS);
	}

	private async writeUnwritten(): Promise<void> {
		if (this.unwritten.size === 0) return;
		try {
			await ensureDir(this.adapter, this.dir);
			const files = await this.files();
			for (const [docId, unwritten] of [...this.unwritten]) {
				const saved = await onDisk(unwritten);
				if (!saved && ++unwritten.tries < MAX_TRIES) {
					this.schedule();
					continue;
				}
				if (saved) {
					const { agreed } = unwritten;
					await this.adapter.write(this.pathOf(docId), JSON.stringify(agreed));
					files.add(this.pathOf(docId));
				}
				// A newer base may have come meanwhile.
				if (this.unwritten.get(docId) === unwritten) {
					this.unwritten.delete(docId);
				}
			}
		} catch (err) {
			reportWarning("Could not save the live editing base.", err);
		}
	}

	async prune(): Promise<void> {
		try {
			const files = await this.files();
			if (files.size <= MAX_KEPT) return;
			const aged = await Promise.all(
				[...files].map(async (path) => ({
					path,
					mtime: (await this.adapter.stat(path))?.mtime ?? 0,
				})),
			);
			aged.sort((a, b) => b.mtime - a.mtime);
			for (const { path } of aged.slice(MAX_KEPT)) {
				await this.adapter.remove(path);
				files.delete(path);
			}
		} catch (err) {
			reportWarning("Could not prune old live editing bases.", err);
		}
	}

	private async files(): Promise<Set<string>> {
		this.stored ??= this.list();
		try {
			return await this.stored;
		} catch {
			this.stored = null;
			return new Set();
		}
	}

	private async list(): Promise<Set<string>> {
		if (!(await this.adapter.exists(this.dir))) return new Set();
		return new Set((await this.adapter.list(this.dir)).files);
	}

	private pathOf(docId: string): string {
		return `${this.dir}/${docId}.json`;
	}
}

function isAgreedText(value: unknown): value is AgreedText {
	const candidate = value as AgreedText | null;
	return (
		typeof candidate?.text === "string" &&
		typeof candidate.gen === "number" &&
		typeof candidate.seq === "number"
	);
}

async function onDisk(unwritten: Unwritten): Promise<boolean> {
	return (await unwritten.onDisk?.()) ?? true;
}
