import type { DataAdapter } from "obsidian";
import { type EncryptionKey, sha256Hex } from "@/crypto";
import type { ObjectStorage } from "@/storage/types";
import { FORCE_DIFF_MAX_BYTES, HUNK_TEXT_MAX_BYTES } from "@/sync/constants";
import {
	bytesToText,
	hasBinaryBytes,
	hasKnownBinaryExtension,
	loadBaselineText,
	loadLocalBytes,
	loadRemoteBytes,
	textToBytes,
} from "./content";
import { type ComputedHunks, computeHunks } from "./hunks";
import { sidesOf } from "./moves";
import type {
	Conflict,
	EChangeType,
	FileChange,
	Manifest,
	Move,
} from "./types";

export const EDiffDirection = {
	Local: "local",
	Remote: "remote",
	Conflict: "conflict",
	History: "history",
} as const;
export type EDiffDirection =
	(typeof EDiffDirection)[keyof typeof EDiffDirection];

export interface FileDiffModel {
	path: string;
	direction: EDiffDirection;
	changeType: EChangeType | "conflict";
	leftText: string;
	rightText: string;
	baseText: string | null;
	hunks: ComputedHunks;
	leftLabel: string;
	rightLabel: string;
	isBinary: boolean;
	/** sha256 of each side; hunk ops verify them first so a concurrently edited file is not misaddressed. */
	leftHash: string;
	rightHash: string;
	/** True when binary purely due to diff size cap; a force-text diff would succeed. */
	forceTextAvailable: boolean;
	/** An absent side reads as empty text, indistinguishable from an empty file without this. */
	leftPresent: boolean;
	rightPresent: boolean;
	leftSize: number;
	rightSize: number;
	/** Where a moved file was: its hunks are not applied one by one. */
	movedFrom?: string;
}

export interface ProjectionDeps {
	adapter: DataAdapter;
	storage: ObjectStorage;
	key: EncryptionKey;
	baseline: Manifest | null;
	remote: Manifest | null;
}

interface DiffSide {
	text: string;
	size: number;
	binary: boolean;
	/** Binary only due to the size cap (no NUL, within force ceiling). */
	capped: boolean;
	/** False when the file is not there, as opposed to there and empty. */
	present: boolean;
}

/** A diff side without reading content: `size` is `null` if absent, `undefined` if unknown without loading. */
interface SideSource {
	path: string;
	size: number | null | undefined;
	load: () => Promise<Uint8Array | null>;
}

const ABSENT_SIDE: DiffSide = {
	text: "",
	size: 0,
	binary: false,
	capped: false,
	present: false,
};

function binarySide(size: number, capped: boolean): DiffSide {
	return { text: "", size, binary: true, capped, present: true };
}

/**
 * Absent is empty/non-binary; known binary extensions are never read or forceable; oversized is binary unless
 * forceText within FORCE_DIFF_MAX_BYTES. Only sides passing these gates are NUL-sniffed.
 */
async function resolveSide(
	source: SideSource,
	forceText: boolean,
): Promise<DiffSide> {
	if (source.size === null) return ABSENT_SIDE;
	const size = source.size;
	if (hasKnownBinaryExtension(source.path)) {
		return binarySide(size ?? (await sizeByLoad(source)), false);
	}
	if (size !== undefined) {
		if (size > FORCE_DIFF_MAX_BYTES) return binarySide(size, false);
		if (size > HUNK_TEXT_MAX_BYTES && !forceText) {
			return binarySide(size, true);
		}
	}
	const bytes = await source.load();
	if (!bytes) return ABSENT_SIDE;
	return decodeLoadedSide(bytes, forceText);
}

async function sizeByLoad(source: SideSource): Promise<number> {
	const bytes = await source.load();
	return bytes?.length ?? 0;
}

function decodeLoadedSide(bytes: Uint8Array, forceText: boolean): DiffSide {
	const size = bytes.length;
	if (hasBinaryBytes(bytes)) return binarySide(size, false);
	if (
		size <= HUNK_TEXT_MAX_BYTES ||
		(forceText && size <= FORCE_DIFF_MAX_BYTES)
	) {
		return {
			text: bytesToText(bytes),
			size,
			binary: false,
			capped: false,
			present: true,
		};
	}
	return binarySide(size, size <= FORCE_DIFF_MAX_BYTES);
}

function localSource(adapter: DataAdapter, path: string): SideSource {
	return {
		path,
		size: undefined,
		load: () => loadLocalBytes(adapter, path),
	};
}

async function statLocalSource(
	adapter: DataAdapter,
	path: string,
): Promise<SideSource> {
	try {
		const stat = await adapter.stat(path);
		if (stat?.type !== "file") {
			return { path, size: null, load: async () => null };
		}
		return {
			path,
			size: stat.size,
			load: () => loadLocalBytes(adapter, path),
		};
	} catch {
		return localSource(adapter, path);
	}
}

function manifestSource(
	deps: Pick<ProjectionDeps, "storage" | "key">,
	manifest: Manifest | null,
	path: string,
): SideSource {
	const entry = manifest?.files[path];
	if (!entry) return { path, size: null, load: async () => null };
	return {
		path,
		size: entry.size,
		load: () =>
			loadRemoteBytes({ storage: deps.storage, key: deps.key }, entry.hash),
	};
}

async function assemble(
	base: {
		path: string;
		direction: EDiffDirection;
		changeType: EChangeType | "conflict";
		leftLabel: string;
		rightLabel: string;
		baseText: string | null;
		movedFrom?: string;
	},
	leftSource: SideSource,
	rightSource: SideSource,
	forceText: boolean,
): Promise<FileDiffModel> {
	const [left, right] = await Promise.all([
		resolveSide(leftSource, forceText),
		resolveSide(rightSource, forceText),
	]);
	const isBinary = left.binary || right.binary;
	// Forceable only if every binary side is binary due to size: no NUL side and nothing over the force ceiling.
	const forceTextAvailable =
		isBinary &&
		(left.capped || right.capped) &&
		!(left.binary && !left.capped) &&
		!(right.binary && !right.capped);
	return {
		...base,
		leftText: left.text,
		rightText: right.text,
		// Skips hunk computation for binary diffs.
		hunks: isBinary
			? computeHunks("", "")
			: computeHunks(left.text, right.text),
		isBinary,
		forceTextAvailable,
		leftHash: await sha256Hex(textToBytes(left.text)),
		rightHash: await sha256Hex(textToBytes(right.text)),
		leftSize: left.size,
		rightSize: right.size,
		leftPresent: left.present,
		rightPresent: right.present,
	};
}

/** A move compares the text it left with the text it arrived with. */
export async function buildLocalChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
	move?: Move,
): Promise<FileDiffModel> {
	const { here } = move ? sidesOf(move) : { here: change.path };
	return assemble(
		{
			path: here,
			direction: EDiffDirection.Local,
			changeType: change.type,
			leftLabel: "Baseline",
			rightLabel: "Local",
			baseText: null,
			movedFrom: move?.from,
		},
		manifestSource(deps, deps.baseline, move?.from ?? change.path),
		await statLocalSource(deps.adapter, here),
		forceText,
	);
}

export async function buildRemoteChangeDiff(
	deps: ProjectionDeps,
	change: FileChange,
	forceText = false,
	move?: Move,
): Promise<FileDiffModel> {
	const { here, there } = move
		? sidesOf(move)
		: { here: change.path, there: change.path };
	return assemble(
		{
			path: move?.to ?? change.path,
			direction: EDiffDirection.Remote,
			changeType: change.type,
			leftLabel: "Local",
			rightLabel: "Remote",
			baseText: null,
			movedFrom: move?.from,
		},
		await statLocalSource(deps.adapter, here),
		manifestSource(deps, deps.remote, there),
		forceText,
	);
}

/** A stored version, addressed by content hash. */
export interface HistoryVersionRef {
	hash: string;
	label: string;
	size?: number;
}

/** Either a stored version, the file as it stands in the vault, or explicitly absent. */
export type HistoryDiffSide =
	| { version: HistoryVersionRef }
	| { current: true; label?: string }
	| { absent: true; label: string };

export interface HistoryDiffRequest {
	path: string;
	/** Removed lines come from here. */
	left: HistoryDiffSide;
	/** Added lines come from here. */
	right: HistoryDiffSide;
	forceText?: boolean;
}

export async function buildHistoryDiff(
	deps: Pick<ProjectionDeps, "adapter" | "storage" | "key">,
	request: HistoryDiffRequest,
): Promise<FileDiffModel> {
	const { path, left, right } = request;
	const [leftSource, rightSource] = await Promise.all([
		historySource(deps, path, left),
		historySource(deps, path, right),
	]);
	return assemble(
		{
			path,
			direction: EDiffDirection.History,
			changeType: "conflict",
			leftLabel: sideLabel(left),
			rightLabel: sideLabel(right),
			baseText: null,
		},
		leftSource,
		rightSource,
		request.forceText ?? false,
	);
}

function sideLabel(side: HistoryDiffSide): string {
	if ("version" in side) return side.version.label;
	if ("absent" in side) return side.label;
	return side.label ?? "Current";
}

async function historySource(
	deps: Pick<ProjectionDeps, "adapter" | "storage" | "key">,
	path: string,
	side: HistoryDiffSide,
): Promise<SideSource> {
	if ("absent" in side) return { path, size: null, load: async () => null };
	if ("version" in side) {
		const { hash, size } = side.version;
		return {
			path,
			size,
			load: async () => {
				const bytes = await loadRemoteBytes(deps, hash);
				if (!bytes) throw new Error("This version is no longer available.");
				return bytes;
			},
		};
	}
	return statLocalSource(deps.adapter, path);
}

export async function buildConflictDiff(
	deps: ProjectionDeps,
	conflict: Conflict,
	forceText = false,
): Promise<FileDiffModel> {
	const [leftSource, baseText] = await Promise.all([
		statLocalSource(deps.adapter, conflict.path),
		loadBaselineText(
			{ storage: deps.storage, key: deps.key },
			deps.baseline,
			conflict.path,
		),
	]);
	return assemble(
		{
			path: conflict.path,
			direction: EDiffDirection.Conflict,
			changeType: "conflict",
			leftLabel: "Local",
			rightLabel: "Remote",
			baseText,
		},
		leftSource,
		manifestSource(deps, deps.remote, conflict.path),
		forceText,
	);
}
