import type { EngineDependencies } from "../engine";
import { hunkBaseline } from "../operations/text-loaders";
import type { Conflict, FileChange, Move } from "../types";
import { trimOldest } from "./bounded-map";
import {
	buildConflictDiff,
	buildLocalChangeDiff,
	buildRemoteChangeDiff,
	type FileDiffModel,
	type ProjectionDeps,
} from "./projection";

/** Total text the cache may retain: forced diffs must not pin megabytes of strings. */
const DIFF_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface PathStatusInput {
	change?: FileChange;
	conflict?: Conflict;
	move?: Move;
}

export interface DiffCacheInput {
	path: string;
	status: PathStatusInput;
	deps: EngineDependencies;
	remote: ProjectionDeps["remote"];
	forceText?: boolean;
}

const DIFF_CACHE_MAX_ENTRIES = 64;

export class DiffCache {
	private readonly entries = new Map<string, FileDiffModel>();

	clear(): void {
		this.entries.clear();
	}

	async get(input: DiffCacheInput): Promise<FileDiffModel | null> {
		const forceText = input.forceText === true;
		const cacheKey = keyFor(input.path, input.status, forceText);
		const hit = this.entries.get(cacheKey);
		if (hit) {
			// Moves to most-recent for LRU eviction.
			this.entries.delete(cacheKey);
			this.entries.set(cacheKey, hit);
			return hit;
		}
		const projection: ProjectionDeps = {
			adapter: input.deps.adapter,
			storage: input.deps.storage,
			key: input.deps.key,
			baseline: hunkBaseline(input.deps, input.remote),
			remote: input.remote,
		};
		const model = await buildModel(projection, input.status, forceText);
		if (model) {
			// A concurrent miss may have stored the key: delete first so this model is the newest.
			this.entries.delete(cacheKey);
			this.entries.set(cacheKey, model);
			trimOldest(
				this.entries,
				DIFF_CACHE_MAX_BYTES,
				modelBytes,
				DIFF_CACHE_MAX_ENTRIES,
			);
		}
		return model;
	}
}

function modelBytes(model: FileDiffModel): number {
	return (
		model.leftText.length +
		model.rightText.length +
		(model.baseText?.length ?? 0)
	);
}

async function buildModel(
	projection: ProjectionDeps,
	status: PathStatusInput,
	forceText: boolean,
): Promise<FileDiffModel | null> {
	if (status.conflict) {
		return buildConflictDiff(projection, status.conflict, forceText);
	}
	if (status.change) {
		const build = status.change.type.startsWith("local")
			? buildLocalChangeDiff
			: buildRemoteChangeDiff;
		return build(projection, status.change, forceText, status.move);
	}
	return null;
}

function keyFor(
	path: string,
	status: PathStatusInput,
	forceText: boolean,
): string {
	// Kind must be in key because conflicts and changes can share hashes but differ in model.
	const kind = status.conflict ? "c" : (status.change?.type ?? "none");
	const local = status.change?.localHash ?? status.conflict?.localHash ?? "";
	const remote = status.change?.remoteHash ?? status.conflict?.remoteHash ?? "";
	const base = status.conflict?.baselineHash ?? "";
	const from = status.move?.from ?? "";
	return `${kind}|${path}|${from}|${local}|${remote}|${base}|${forceText ? "f" : ""}`;
}
