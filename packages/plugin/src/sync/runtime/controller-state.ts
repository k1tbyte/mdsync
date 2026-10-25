import type { CompareResult } from "@/sync/engine";
import { changeCount } from "@/sync/moves";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { StatusBroadcaster } from "@/sync/status-broadcaster";
import { mergeResults } from "./merged-result";

/** A shared folder the last refresh could not compare; the others went on. */
export interface SpaceError {
	root: string;
	message: string;
	/** It lost every file it had here: `settleGone` resolves it. */
	gone?: true;
}

/** The vault's last compare and the storage it ran against. */
export interface VaultCheck {
	storage: string;
	at: number;
}

export interface SyncStatusSnapshot {
	pendingLocal: number;
	pendingRemote: number;
	conflicts: number;
	lastCompareAt: number | null;
	/** Moves when a compare or an operation installs or clears results, never for a saved-file patch. */
	resultRevision: number;
	vaultCheck: VaultCheck | null;
	busy: boolean;
	error: string | null;
	spaceErrors: readonly SpaceError[];
	result: CompareResult | null;
	progressText: string | null;
	/** Share done of a counted operation, 0 to 1. */
	progressRatio: number | null;
	staleReason: string | null;
	/** An operation that can be stopped is running. */
	cancellable: boolean;
}

export type SyncStatusListener = (snapshot: SyncStatusSnapshot) => void;

export class SyncControllerRuntimeState {
	/** Keyed by space id, in the order the spaces were listed. */
	private results = new Map<string, CompareResult>();
	private merged: CompareResult | null = null;
	/** The partition of the last refresh; operations route by it until the next. */
	private partition: readonly Space[] = [VAULT_SPACE];
	private resultAt: number | null = null;
	private resultRevision = 0;
	private vaultCheck: VaultCheck | null = null;
	private pendingOps = 0;
	private error: string | null = null;
	private spaceErrors: readonly SpaceError[] = [];
	private progressText: string | null = null;
	private progressRatio: number | null = null;
	private staleReason: string | null = null;
	private readonly broadcaster: StatusBroadcaster<SyncStatusSnapshot>;
	private chain: Promise<void> = Promise.resolve();
	private aborter: AbortController | null = null;
	/** Bumped by `invalidate`: work begun before it publishes no results. */
	private epoch = 0;

	constructor() {
		this.broadcaster = new StatusBroadcaster<SyncStatusSnapshot>({
			getSnapshot: () => this.getSnapshot(),
		});
	}

	getSnapshot(): SyncStatusSnapshot {
		const result = this.getResult();
		const diff = result?.diff;
		return {
			pendingLocal: diff ? changeCount(diff.localChanges, diff.moves) : 0,
			pendingRemote: diff ? changeCount(diff.remoteChanges, diff.moves) : 0,
			conflicts: diff?.conflicts.length ?? 0,
			lastCompareAt: this.resultAt,
			resultRevision: this.resultRevision,
			vaultCheck: this.vaultCheck,
			busy: this.pendingOps > 0,
			error: this.error,
			spaceErrors: this.spaceErrors,
			result,
			progressText: this.progressText,
			progressRatio: this.progressRatio,
			staleReason: this.staleReason,
			cancellable: this.aborter !== null && !this.aborter.signal.aborted,
		};
	}

	/** Every space's compare as one; the UI reads this. */
	getResult(): CompareResult | null {
		this.merged ??= mergeResults([...this.results.values()]);
		return this.merged;
	}

	spaces(): readonly Space[] {
		return this.partition;
	}

	setSpaces(spaces: readonly Space[]): void {
		this.partition = spaces;
	}

	resultOf(space: Space): CompareResult | null {
		return this.results.get(space.id) ?? null;
	}

	subscribe(listener: SyncStatusListener): () => void {
		return this.broadcaster.subscribe(listener);
	}

	dispose(): void {
		this.broadcaster.dispose();
		// A push or pull left running would finish against the next instance's state.
		this.cancel();
		// Closures outliving unload keep this scope alive; what survives should be empty, not 20k files of compare.
		this.clearResult();
		this.error = null;
		this.spaceErrors = [];
		this.progressText = null;
		this.progressRatio = null;
	}

	/** A space that compared again is no longer failing. */
	setResult(space: Space, result: CompareResult): void {
		this.results.set(space.id, result);
		this.spaceErrors = this.spaceErrors.filter(
			(error) => error.root !== space.root,
		);
		this.merged = null;
		this.resultAt = Date.now();
		this.resultRevision++;
	}

	/** A display-only fix of one space's result: no compare ran, so neither the time nor the errors move. */
	patchResult(space: Space, result: CompareResult): void {
		this.results.set(space.id, result);
		this.merged = null;
	}

	/** A full refresh: spaces no longer listed drop out. */
	setResults(results: ReadonlyMap<Space, CompareResult>): void {
		this.results = new Map(
			[...results].map(([space, result]) => [space.id, result]),
		);
		this.merged = null;
		this.resultAt = Date.now();
		this.resultRevision++;
	}

	/** The vault compared against `storage` just now. */
	setVaultChecked(storage: string): void {
		this.vaultCheck = { storage, at: Date.now() };
	}

	clearResult(): void {
		this.results.clear();
		this.merged = null;
		this.resultRevision++;
	}

	setError(error: string | null): void {
		this.error = error;
	}

	clearError(): void {
		this.error = null;
	}

	setSpaceErrors(errors: readonly SpaceError[]): void {
		this.spaceErrors = errors;
	}

	setProgressText(progressText: string | null, progressRatio?: number): void {
		this.progressText = progressText;
		this.progressRatio = progressRatio ?? null;
	}

	publishProgress(progressText: string | null, progressRatio?: number): void {
		this.setProgressText(progressText, progressRatio);
		this.broadcast();
	}

	publishProgressSoon(
		progressText: string | null,
		progressRatio?: number,
	): void {
		this.setProgressText(progressText, progressRatio);
		this.broadcastSoon();
	}

	setStaleReason(staleReason: string | null): void {
		this.staleReason = staleReason;
	}

	currentEpoch(): number {
		return this.epoch;
	}

	invalidate(reason: string): void {
		this.epoch++;
		this.clearResult();
		this.error = null;
		this.spaceErrors = [];
		this.progressText = null;
		this.progressRatio = null;
		this.staleReason = reason;
		this.broadcast();
	}

	broadcast(): void {
		this.broadcaster.broadcast();
	}

	broadcastSoon(): void {
		this.broadcaster.broadcastSoon();
	}

	/**
	 * Nested calls share the outer scope so an inner step cannot revoke stopping the whole. Open only around
	 * work that reads the signal: a Cancel button over an ignoring operation is worse than none.
	 */
	beginCancellable(): { signal: AbortSignal; end: () => void } {
		if (this.aborter) {
			return { signal: this.aborter.signal, end: () => {} };
		}
		const aborter = new AbortController();
		this.aborter = aborter;
		this.broadcast();
		return {
			signal: aborter.signal,
			end: () => {
				if (this.aborter !== aborter) return;
				this.aborter = null;
				this.broadcast();
			},
		};
	}

	cancel(): void {
		// Without a scope nothing can stop, and an uncleared status would stick.
		if (!this.aborter || this.aborter.signal.aborted) return;
		this.aborter.abort();
		this.publishProgress("Cancelling…");
	}

	/** Takes its turn in the chain without counting as an operation: `busy` never flips for it. */
	enqueueQuiet<T>(task: () => Promise<T>): Promise<T> {
		const run = this.chain.then(task);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		this.pendingOps++;
		if (this.pendingOps === 1) this.broadcast();
		const run = this.enqueueQuiet(task);
		const finish = (): void => {
			this.pendingOps--;
			if (this.pendingOps === 0) this.broadcast();
		};
		run.then(finish, finish);
		return run;
	}
}
