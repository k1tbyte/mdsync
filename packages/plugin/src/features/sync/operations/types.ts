import type { ESyncLogOperation } from "@/core/logs";
import type { CompareResult, EngineDependencies } from "../engine";
import type { Manifest, ManifestEntry, SessionState } from "../types";

export type SyncOperationResult = { ok: true } | { ok: false; error?: string };

export interface OperationOutcome {
	newRemote: Manifest | null;
	touchedPaths: ReadonlySet<string>;
	/**
	 * On-disk state of touched paths, so `recomputeAfterWrite` does not assume baseline/remote state after a
	 * partial hunk apply.
	 */
	localEntries?: ReadonlyMap<string, ManifestEntry | null>;
	/** Stopped early at the user's request, having done part of the work. */
	cancelled?: boolean;
}

/** `ratio` is the share done, 0 to 1; only counted steps give it. */
export type ProgressReporter = (text: string | null, ratio?: number) => void;

export interface OperationContext {
	setProgress: ProgressReporter;
	reportProgressSoon: ProgressReporter;
	persistState: (state: SessionState) => Promise<void>;
	getFreshState: () => SessionState;
	logInfo: (
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	) => Promise<void>;
}

export type Operation<TArgs, TResult = OperationOutcome> = (
	deps: EngineDependencies,
	result: CompareResult,
	args: TArgs,
	ctx: OperationContext,
) => Promise<TResult>;
