import type { DataAdapter } from "obsidian";

import { createSymlinkDetector, type SymlinkDetector } from "@/vault/symlinks";
import type { FileExplorerRows } from "./file-explorer-api";

const BATCH = 64;
const NO_LINKS: ReadonlyMap<string, string> = new Map();

interface LinkScanHost {
	enabled(): boolean;
	explorer(): FileExplorerRows | null;
	linksChanged(): void;
}

export class LinkScan {
	private detector: SymlinkDetector;
	private enabled: boolean;
	private checked = new Set<string>();
	private found = NO_LINKS;
	private frame: number | null = null;
	private again = false;
	private generation = 0;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly host: LinkScanHost,
	) {
		this.enabled = host.enabled();
		this.detector = createSymlinkDetector(adapter, this.enabled);
	}

	get links(): ReadonlyMap<string, string> {
		return this.found;
	}

	followSetting(): boolean {
		if (this.host.enabled() === this.enabled) return false;
		this.reset();
		return true;
	}

	reset(): void {
		this.stop();
		this.again = false;
		this.enabled = this.host.enabled();
		this.detector = createSymlinkDetector(this.adapter, this.enabled);
		this.checked = new Set();
		this.found = NO_LINKS;
	}

	stop(): void {
		this.generation++;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
	}

	scan(): void {
		const explorer = this.host.explorer();
		if (!explorer) return;
		if (this.frame !== null) {
			this.again = true;
			return;
		}
		if (!this.enabled) {
			this.found = NO_LINKS;
			return;
		}
		const paths = explorer.paths();
		const pending = paths.filter((path) => !this.checked.has(path));
		const visible = new Set(paths);
		const found = new Map(
			[...this.found].filter(([path]) => visible.has(path)),
		);
		if (pending.length === 0) this.publish(found);
		else this.check(pending, found);
	}

	private check(pending: string[], found: Map<string, string>): void {
		const generation = ++this.generation;
		let index = 0;
		const batch = (): void => {
			if (generation !== this.generation) return;
			const end = Math.min(index + BATCH, pending.length);
			for (; index < end; index++) {
				const path = pending[index];
				if (!path) continue;
				this.checked.add(path);
				if (this.detector.findLink(path) === path) found.set(path, path);
			}
			if (index < pending.length) {
				this.frame = window.requestAnimationFrame(batch);
				return;
			}
			this.frame = null;
			this.publish(found);
			if (this.again) {
				this.again = false;
				this.scan();
			}
		};
		this.frame = window.requestAnimationFrame(batch);
	}

	private publish(found: ReadonlyMap<string, string>): void {
		if (sameStringMap(found, this.found)) return;
		this.found = found;
		this.host.linksChanged();
	}
}

function sameStringMap(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false;
	}
	return true;
}
