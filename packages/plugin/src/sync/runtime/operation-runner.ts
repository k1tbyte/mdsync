import { ESyncLogOperation } from "@/logs/store";
import { errorMessage } from "@/shared";
import { ShareRefusedError, StorageRequestError } from "@/storage";
import { publishedByOthers, publisher } from "@/sync/authors";
import { advanceBaselineForPaths } from "@/sync/baseline";
import { isCancellation } from "@/sync/cancel";
import { reconcileBaselineResetGenerations } from "@/sync/config-reset";
import type { SyncControllerHost } from "@/sync/controller";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
} from "@/sync/engine";
import { forgetDroppedForeign, heldShareBases } from "@/sync/foreign";
import { ConcurrentPushError } from "@/sync/manifest";
import type {
	OperationContext,
	OperationOutcome,
	SyncOperationResult,
} from "@/sync/operations";
import { deleteShareObjects } from "@/sync/reset";
import {
	forgetShare,
	mergeSessionIntoLocal,
	projectSession,
	recomputeAfterWrite,
	sharesHold,
} from "@/sync/session-state";
import { type Space, SpaceGoneError, VAULT_SPACE } from "@/sync/space";
import type { LocalState, SessionState } from "@/sync/types";
import type {
	SpaceError,
	SyncControllerRuntimeState,
} from "./controller-state";
import { ScanCycle } from "./scan-cycle";

/** An operation with its arguments bound, run against one space. */
export type SpaceOperation = (
	deps: EngineDependencies,
	result: CompareResult,
	ctx: OperationContext,
) => Promise<OperationOutcome>;

interface OperationRunnerDeps {
	host: SyncControllerHost;
	runtimeState: SyncControllerRuntimeState;
	clearFileDiffs: () => void;
	localRevision?: () => number;
}

export class OperationRunner {
	private walkDisk = true;
	/** What the last refresh found on disk past Obsidian's index. */
	private unindexed: ReadonlySet<string> = new Set();

	constructor(private readonly deps: OperationRunnerDeps) {}

	private applyResult(
		space: Space,
		result: CompareResult,
		epoch: number,
	): void {
		if (this.invalidatedSince(epoch)) return;
		this.deps.runtimeState.setResult(space, result);
		this.settled();
	}

	/** Its partition or scope may be stale then, and a settled state would let auto-push act on it. */
	private invalidatedSince(epoch: number): boolean {
		return this.deps.runtimeState.currentEpoch() !== epoch;
	}

	private settled(): void {
		this.deps.clearFileDiffs();
		this.deps.runtimeState.setStaleReason(null);
	}

	async refreshNow(targets: ReadonlySet<string> | null = null): Promise<void> {
		const before = this.deps.runtimeState.getSnapshot();
		this.deps.runtimeState.clearError();
		this.deps.runtimeState.publishProgress("Refreshing…");
		const epoch = this.deps.runtimeState.currentEpoch();
		try {
			const spaces =
				targets === null
					? await this.deps.host.spaces()
					: this.deps.runtimeState.spaces();
			if (!spaces) return;
			this.deps.runtimeState.setSpaces(spaces);
			const results = new Map<Space, CompareResult>();
			const refreshedRoots = new Set(
				spaces
					.filter((space) => targets === null || targets.has(space.id))
					.map((space) => space.root),
			);
			const failed: SpaceError[] =
				targets === null
					? []
					: before.spaceErrors.filter(
							(error) => !refreshedRoots.has(error.root),
						);
			let local = this.deps.host.getState();
			const cycle = new ScanCycle(spaces, local.hashCache);
			const walk = targets === null && this.walkDisk;
			for (const space of spaces) {
				if (space.paused) continue;
				if (targets !== null && !targets.has(space.id)) {
					const kept = this.deps.runtimeState.resultOf(space);
					if (kept) results.set(space, kept);
					continue;
				}
				try {
					const refreshed = await this.refreshSpace(space, local, cycle, walk);
					if (!refreshed) continue;
					local = refreshed.local;
					results.set(space, refreshed.result);
					this.deps.host.onSpaceRefreshed?.(space);
				} catch (err) {
					if (space.root === VAULT_SPACE.root) throw err;
					const message = await this.logFailure(
						ESyncLogOperation.Compare,
						err,
						`Shared folder "${space.root}": `,
					);
					const gone = err instanceof SpaceGoneError;
					failed.push({ root: space.root, message, ...(gone ? { gone } : {}) });
				}
			}
			if (this.invalidatedSince(epoch)) return;
			await this.deps.host.persistState({
				...this.deps.host.getState(),
				storages: local.storages,
				hashCache: cycle.cache,
			});
			if (this.invalidatedSince(epoch)) return;
			this.deps.runtimeState.setResults(results);
			this.deps.runtimeState.setSpaceErrors(failed);
			this.unindexed = new Set(
				[...results.values()].flatMap(
					({ snapshot }) => snapshot.unindexed ?? [],
				),
			);
			// Cleared only here: an invalidated walk is owed to the next refresh.
			if (walk) {
				this.walkDisk = false;
				if (this.unindexed.size > 0) {
					this.deps.host.onUnindexed?.(this.unindexed.size);
				}
			}
			this.settled();
		} catch (err) {
			await this.reportError(ESyncLogOperation.Compare, err);
		} finally {
			this.deps.runtimeState.setProgressText(null);
		}
	}

	private async refreshSpace(
		space: Space,
		local: LocalState,
		cycle: ScanCycle,
		walk: boolean,
	): Promise<{ result: CompareResult; local: LocalState } | null> {
		const session = await this.openSession(space);
		if (!session) return null;
		const depsWithProgress: EngineDependencies = {
			...session,
			index: cycle.indexFor(space, session.index),
			state: { ...session.state, hashCache: cycle.hashesFor(space) },
			walkDisk: walk,
			onScanProgress: (scanned) => {
				this.deps.runtimeState.publishProgressSoon(
					`Scanning… ${scanned} files`,
				);
			},
		};
		const result = await compare(depsWithProgress).catch((err: unknown) => {
			if (err instanceof ShareRefusedError)
				this.deps.host.onShareRefused?.(space);
			if (err instanceof SpaceGoneError) this.deps.host.onSpaceGone?.(space);
			throw err;
		});
		const identity = session.storage.identity();
		const reconciled = result.remote
			? reconcileBaselineResetGenerations(
					session.state.baseline,
					result.remote,
					session.scope,
				)
			: session.state.baseline;
		const baseline = result.remote
			? forgetDroppedForeign(reconciled, result.remote, session.scope)
			: reconciled;
		const advanced =
			result.remote && result.diff.converged.length > 0
				? advanceBaselineForPaths(
						baseline,
						result.remote,
						new Set(result.diff.converged),
						result.snapshot.emptyFolders,
						session.scope,
					)
				: baseline;

		cycle.update(space, result.updatedCache);
		const nextSessionState: SessionState = {
			...session.state,
			// Both sides reached same content; adopt baseline to prevent phantom conflicts.
			baseline: advanced,
			vaultId: session.state.vaultId ?? result.remote?.vaultId ?? null,
			hashCache: cycle.cache,
		};
		const shareBases =
			result.remote && space.id === VAULT_SPACE.id
				? heldShareBases(
						local.storages[identity]?.shareBases,
						reconciled,
						result.remote,
						session.scope,
						sharesHold(local, this.deps.runtimeState.spaces()),
					)
				: undefined;
		return {
			result,
			local: mergeSessionIntoLocal(
				local,
				nextSessionState,
				identity,
				space,
				shareBases,
			),
		};
	}

	/** The next full refresh lists the disk too; the first one after launch does. */
	walkDiskNext(): void {
		this.walkDisk = true;
	}

	/**
	 * Drops this device's state of a share so it mounts afresh (an old baseline would read the new empty
	 * folder as deleted); `deleteRemote` also empties a closed share's storage.
	 */
	forget(space: Space, { deleteRemote = false } = {}): Promise<void> {
		return this.deps.runtimeState.enqueue(async () => {
			const { host } = this.deps;
			await host.persistState(forgetShare(host.getState(), space.id));
			if (!deleteRemote) return;
			const session = await this.openSession(space);
			if (!session) throw new Error("The storage could not be opened.");
			await deleteShareObjects(session);
		});
	}

	/** Flows act on the vault's own storage: resets, adoption. */
	runFlow(
		operation: ESyncLogOperation,
		flow: (
			deps: EngineDependencies,
			ctx: OperationContext,
		) => Promise<{ compareResult: CompareResult }>,
	): Promise<boolean> {
		return this.deps.runtimeState.enqueue(async () => {
			this.deps.runtimeState.clearError();
			this.deps.runtimeState.broadcast();
			const epoch = this.deps.runtimeState.currentEpoch();
			try {
				const session = await this.openSession(VAULT_SPACE);
				if (!session) return false;
				const ctx = this.buildContext(session);
				const { compareResult } = await flow(session, ctx);
				this.applyResult(VAULT_SPACE, compareResult, epoch);
				return true;
			} catch (err) {
				await this.reportError(operation, err);
				return false;
			} finally {
				this.deps.runtimeState.setProgressText(null);
			}
		});
	}

	runOperation(
		space: Space,
		operation: ESyncLogOperation,
		fn: SpaceOperation,
		/** Only for operations that read `deps.signal`; see `sync/cancel.ts`. */
		cancellable = false,
	): Promise<SyncOperationResult> {
		return this.deps.runtimeState.enqueue(() =>
			this.runOperationNow(space, operation, fn, cancellable),
		);
	}

	async runOperationNow(
		space: Space,
		operation: ESyncLogOperation,
		fn: SpaceOperation,
		cancellable = false,
		comparison?: { result: CompareResult; epoch: number; revision?: number },
	): Promise<SyncOperationResult> {
		this.deps.runtimeState.clearError();
		// Routed when it was asked for: a refresh since may have moved or closed its space.
		const mounted = this.deps.runtimeState
			.spaces()
			.some(({ id, root }) => id === space.id && root === space.root);
		if (!mounted) {
			return {
				ok: false,
				error: "Shared folders changed meanwhile. Try again.",
			};
		}
		const epoch = this.deps.runtimeState.currentEpoch();
		let scope: { signal: AbortSignal; end: () => void } | null = null;
		try {
			let session = await this.openSession(space);
			if (!session) return { ok: false };
			if (comparison && this.invalidatedSince(comparison.epoch))
				return { ok: false };
			const current =
				comparison && comparison.revision === this.deps.localRevision?.();
			const configDir = session.scope.configDir;
			// Hidden configuration writes do not emit vault file events.
			const indexedOnly =
				configDir === undefined || !session.scope.canDescend(configDir);
			const result =
				current && indexedOnly
					? { ...comparison.result, updatedCache: session.state.hashCache }
					: await compare(
							session,
							current ? comparison.result.remote : undefined,
						);
			if (this.invalidatedSince(epoch)) return { ok: false };
			if (result.remote) {
				const baseline = reconcileBaselineResetGenerations(
					session.state.baseline,
					result.remote,
					session.scope,
				);
				if (baseline !== session.state.baseline) {
					session = { ...session, state: { ...session.state, baseline } };
					await this.buildContext(session).persistState(session.state);
				}
			}
			this.applyResult(space, result, epoch);
			if (cancellable) scope = this.deps.runtimeState.beginCancellable();
			const ctx = this.buildContext(session);
			const outcome = await fn(
				scope ? { ...session, signal: scope.signal } : session,
				result,
				ctx,
			);
			const freshState = projectSession(
				this.deps.host.getState(),
				session.storage.identity(),
				space.root,
			);
			const recomputed = recomputeAfterWrite(
				result,
				freshState,
				outcome,
				session.scope,
			);
			this.applyResult(space, recomputed, epoch);
			// A first sync brings everything: none of it is news.
			if (operation === ESyncLogOperation.Pull && session.state.baseline) {
				const theirs = publishedByOthers(
					outcome.newRemote,
					outcome.touchedPaths,
					publisher(session.state, session.author).key,
				);
				if (theirs.length > 0) this.deps.host.onTheirsPulled?.(space, theirs);
			}
			if (outcome.cancelled) {
				this.deps.runtimeState.setStaleReason(
					outcome.touchedPaths.size === 0
						? "Stopped before anything changed."
						: `Stopped after ${outcome.touchedPaths.size} file(s). Compare again to see where things stand.`,
				);
				return { ok: false };
			}
			// Only a published manifest is news for the others.
			if (
				operation === ESyncLogOperation.Push &&
				outcome.newRemote !== result.remote
			) {
				this.deps.host.onPushComplete?.(space);
			}
			return { ok: true };
		} catch (err) {
			if (isCancellation(err)) {
				// Not a failure: nothing was published, and saying so beats a red error.
				this.deps.runtimeState.setError(null);
				this.deps.runtimeState.setStaleReason(
					"Stopped before publishing. Nothing on the remote changed.",
				);
				await this.deps.host.logWarn(operation, "Cancelled by the user.");
				return { ok: false };
			}
			if (err instanceof ConcurrentPushError) {
				this.deps.runtimeState.setError(null);
				this.deps.runtimeState.setStaleReason(
					"Remote changed concurrently — re-comparing…",
				);
				this.deps.runtimeState.clearResult();
				this.deps.clearFileDiffs();
				this.deps.runtimeState.broadcast();
				await this.refreshNow();
				await this.deps.host.logWarn(operation, err.message);
				return { ok: false, error: err.message };
			}
			const message = await this.reportError(operation, err);
			return { ok: false, error: message };
		} finally {
			scope?.end();
			// Broadcast, not just set: a queued operation keeps pendingOps above
			// zero, so nothing else would repaint away a stale "Cancelling…".
			this.deps.runtimeState.publishProgress(null);
		}
	}

	/** Every session, reads too: a paused share asks its storage nothing. */
	async openSession(space: Space): Promise<EngineDependencies | null> {
		if (space.paused) {
			throw new Error(`"${space.root}" is paused on this device.`);
		}
		const session = await this.deps.host.openSession(
			space,
			this.deps.runtimeState.spaces(),
		);
		return session && { ...session, unindexed: this.unindexed };
	}

	private async reportError(
		operation: ESyncLogOperation,
		err: unknown,
	): Promise<string> {
		const message = await this.logFailure(operation, err);
		this.deps.runtimeState.setError(message);
		return message;
	}

	/** Logs the failure in full; returns what the user reads. */
	private async logFailure(
		operation: ESyncLogOperation,
		err: unknown,
		where = "",
	): Promise<string> {
		const detail = errorMessage(err);
		await this.deps.host.logError(operation, `${where}${detail}`);
		return err instanceof StorageRequestError ? err.userMessage : detail;
	}

	private buildContext(deps: EngineDependencies): OperationContext {
		const identity = deps.storage.identity();
		const { space } = deps;
		const { root } = space;
		return {
			setProgress: (text) => this.deps.runtimeState.publishProgress(text),
			reportProgressSoon: (text) =>
				this.deps.runtimeState.publishProgressSoon(text),
			persistState: (session) =>
				this.deps.host.persistState(
					mergeSessionIntoLocal(
						this.deps.host.getState(),
						session,
						identity,
						space,
					),
				),
			getFreshState: () =>
				projectSession(this.deps.host.getState(), identity, root),
			logInfo: (op, message, details) =>
				this.deps.host.logInfo(op, message, details),
		};
	}
}
