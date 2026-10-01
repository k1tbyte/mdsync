import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import { skippedFiles } from "@/ui/common";
import type { FileExplorerRows } from "./file-explorer-api";
import {
	type AppliedDecoration,
	type BaseMarks,
	clearDecoration,
	computeBase,
	decorationOf,
	type PathDecoration,
	renderDecoration,
	sameDecoration,
} from "./file-explorer-decorations";
import {
	type PresenceMarks,
	presenceMarks,
	shareMarks,
} from "./file-explorer-marks";

const NO_BASE: ReadonlyMap<string, BaseMarks> = new Map();
const NO_MARKS: ReadonlyMap<string, PresenceMarks> = new Map();

export class RowDecorator {
	private applied = new Map<string, AppliedDecoration>();
	private appliedBase: ReadonlyMap<string, BaseMarks> | null = null;
	private appliedMarks = NO_MARKS;
	private base: {
		inputs: readonly unknown[];
		marks: ReadonlyMap<string, BaseMarks>;
	} | null = null;
	private ignoreVersion = 0;

	constructor(
		private readonly plugin: PluginHost,
		private readonly controller: SyncController,
	) {}

	ignoredChanged(): void {
		this.ignoreVersion++;
	}

	apply(
		explorer: FileExplorerRows,
		directLinks: ReadonlyMap<string, string>,
		indicators: boolean,
		rowsChanged: boolean,
	): void {
		const base = indicators ? this.baseMarks(directLinks) : NO_BASE;
		const marks = indicators
			? presenceMarks(this.plugin, explorer.collapsed)
			: shareMarks(this.plugin);
		const paths =
			rowsChanged || base !== this.appliedBase
				? [...this.applied.keys(), ...base.keys(), ...marks.keys()]
				: [...this.appliedMarks.keys(), ...marks.keys()];
		for (const path of new Set(paths)) {
			this.paint(
				path,
				explorer.row(path),
				decorationOf(base.get(path), marks.get(path)),
			);
		}
		this.appliedBase = base;
		this.appliedMarks = marks;
	}

	clear(): void {
		for (const { target } of this.applied.values()) clearDecoration(target);
		this.applied = new Map();
		this.appliedBase = null;
		this.appliedMarks = NO_MARKS;
	}

	private baseMarks(
		directLinks: ReadonlyMap<string, string>,
	): ReadonlyMap<string, BaseMarks> {
		const inputs = [
			this.controller.fileDiffs.getChangedPathStatuses(),
			skippedFiles(this.controller),
			directLinks,
			this.plugin.spaces.partition(),
			this.ignoreVersion,
		];
		if (this.base?.inputs.every((input, i) => input === inputs[i])) {
			return this.base.marks;
		}
		const marks = computeBase(this.plugin, this.controller, directLinks);
		this.base = { inputs, marks };
		return marks;
	}

	private paint(
		path: string,
		target: HTMLElement | null,
		decoration: PathDecoration | undefined,
	): void {
		const previous = this.applied.get(path);
		if (!decoration || !target) {
			if (previous) clearDecoration(previous.target);
			this.applied.delete(path);
			return;
		}
		if (
			previous?.target === target &&
			sameDecoration(previous.decoration, decoration)
		) {
			return;
		}
		if (previous) clearDecoration(previous.target);
		renderDecoration(target, decoration, this.plugin);
		this.applied.set(path, { decoration, target });
	}
}
