/**
 * Per note, the text this device last knew its room held all of: the base of
 * the merge when the note opens again. A stale base is what made the sync
 * baseline duplicate lines. Keyed by the note's first docId, so the generation
 * it holds is where the note reopens after a rotation. Kept in the plugin
 * folder, which never syncs; a lost or torn file only falls the merge back to
 * that baseline.
 */

import type { DataAdapter } from "obsidian";

import { PLUGIN_ID } from "@/constants";
import { reportWarning } from "@/shared/diagnostics";
import { ensureDir } from "@/vault/io";

export interface AgreedText {
	text: string;
	/** The room's rotation generation. */
	gen: number;
	/** The room's seq the text was agreed at. */
	seq: number;
}

/** Typing agrees several times a second; the disk hears about it at most this often. */
const WRITE_DELAY_MS = 2_000;
/** Documents kept; the oldest go first. */
const MAX_KEPT = 500;

export class AgreedTexts {
	private readonly dir: string;
	private readonly unwritten = new Map<string, AgreedText>();
	private timer: number | null = null;
	/** Listed once: most notes never went live, and each would cost a failed read. */
	private stored: Promise<Set<string>> | null = null;

	constructor(
		private readonly adapter: DataAdapter,
		configDir: string,
	) {
		this.dir = `${configDir.replace(/\/$/, "")}/plugins/${PLUGIN_ID}/live`;
	}

	async get(docId: string): Promise<AgreedText | null> {
		const unwritten = this.unwritten.get(docId);
		if (unwritten) return unwritten;
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

	put(docId: string, agreed: AgreedText): void {
		this.unwritten.set(docId, agreed);
		this.timer ??= window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, WRITE_DELAY_MS);
	}

	async flush(): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (this.unwritten.size === 0) return;
		try {
			await ensureDir(this.adapter, this.dir);
			const files = await this.files();
			for (const [docId, agreed] of [...this.unwritten]) {
				await this.adapter.write(this.pathOf(docId), JSON.stringify(agreed));
				files.add(this.pathOf(docId));
				// Until then the disk holds an older base; a newer one may have come meanwhile.
				if (this.unwritten.get(docId) === agreed) this.unwritten.delete(docId);
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
