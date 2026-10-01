import { ESyncLogOperation } from "@/logs/store";
import type { SettingsSyncCategories } from "@/settings/model";
import { authorOf, type LastEdit } from "./authors";
import { selectAutoPushPaths } from "./auto-push";
import { clearRemoteTextCache } from "./content";
import { defaultDeviceName } from "./device";
import type { EngineDependencies } from "./engine";
import type { HunkSelection } from "./hunks";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	type HunkSidesHash,
	keepBothConflictOp,
	type LocalHunksArgs,
	localHunksOp,
	type MergedSaveArgs,
	type Operation,
	pullHunksOp,
	pullPathsOp,
	pushPathsOp,
	revertPathsOp,
	runAdoptNewVaultFlow,
	runResetRemoteStorageFlow,
	type SyncOperationResult,
	saveMergedOp,
} from "./operations";
import { runCategoryResetFlow } from "./operations/config-reset";
import { runRefreshCycle } from "./runtime/auto-cycle";
import {
	SyncControllerRuntimeState,
	type SyncStatusListener,
	type SyncStatusSnapshot,
} from "./runtime/controller-state";
import { FileDiffService } from "./runtime/file-diff-service";
import { HistoryService } from "./runtime/history-service";
import { MaintenanceService } from "./runtime/maintenance-service";
import {
	OperationRunner,
	type SpaceOperation,
} from "./runtime/operation-runner";
import { RefreshQueue } from "./runtime/refresh-queue";
import { pathsBySpace, type Space, spaceOf, VAULT_SPACE } from "./space";
import type { LocalState } from "./types";

export const EConflictStrategy = {
	KeepLocal: "keep-local",
	AcceptRemote: "accept-remote",
} as const;
export type EConflictStrategy =
	(typeof EConflictStrategy)[keyof typeof EConflictStrategy];

export interface SyncControllerHost {
	/**
	 * The vault first. Asked once per refresh; the partition holds until the next. Null when the vault cannot
	 * open, which ends the refresh.
	 */
	spaces(): Promise<readonly Space[] | null>;
	/** Builds the space's scope from `partition` alone, never from newer records. */
	openSession(
		space: Space,
		partition: readonly Space[],
	): Promise<EngineDependencies | null>;
	persistState(state: LocalState): Promise<void>;
	getState(): LocalState;
	/** Another device may want the space now: its channel is signalled. */
	onPushComplete?(space: Space): void;
	/** Content others published landed here, past the space's first sync. */
	onTheirsPulled?(space: Space, paths: readonly string[]): void;
	/** The space compared fine in a refresh: its storage answers this device. */
	onSpaceRefreshed?(space: Space): void;
	/** The broker refused the share's link: revoked, or too new for its KV yet. */
	onShareRefused?(space: Space): void;
	/** The share lost every file it had here; see `settleGone`. */
	onSpaceGone?(space: Space): void;
	/** A disk walk found files Obsidian's index lacks: synced, shown after a restart. */
	onUnindexed?(count: number): void;
	logInfo(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
	logWarn(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
	logError(
		operation: ESyncLogOperation,
		message: string,
		details?: readonly string[],
	): Promise<void>;
}

export type { SyncOperationResult, SyncStatusListener, SyncStatusSnapshot };

/** Its owner's relay would refuse the write; Revert drops the change. */
const READ_ONLY_PUSH =
	"Files in a read-only shared folder cannot be pushed. Revert them to drop the changes.";

const CONFLICT_STRATEGY_OPS: Record<
	EConflictStrategy,
	{ op: Operation<ReadonlySet<string>>; logOp: ESyncLogOperation }
> = {
	[EConflictStrategy.KeepLocal]: {
		op: batchKeepLocalOp,
		logOp: ESyncLogOperation.Push,
	},
	[EConflictStrategy.AcceptRemote]: {
		op: batchAcceptRemoteOp,
		logOp: ESyncLogOperation.Pull,
	},
};

export class SyncController {
	private readonly host: SyncControllerHost;
	private readonly runtimeState: SyncControllerRuntimeState;
	readonly fileDiffs: FileDiffService;
	private readonly operations: OperationRunner;
	private readonly refreshes: RefreshQueue;
	private localRevision = 0;
	readonly history: HistoryService;
	readonly maintenance: MaintenanceService;

	constructor(host: SyncControllerHost) {
		this.host = host;
		this.runtimeState = new SyncControllerRuntimeState();
		const open = (space: Space) => this.operations.openSession(space);
		this.fileDiffs = new FileDiffService({
			openSession: (path, space) => open(space ?? this.spaceFor(path)),
			getResult: () => this.runtimeState.getResult(),
			shareBases: (identity) =>
				this.host.getState().storages[identity]?.shareBases,
		});
		this.operations = new OperationRunner({
			host: this.host,
			runtimeState: this.runtimeState,
			clearFileDiffs: () => this.fileDiffs.clear(),
			localRevision: () => this.localRevision,
		});
		this.refreshes = new RefreshQueue(
			(run) => this.runtimeState.enqueue(run),
			(request) =>
				runRefreshCycle(
					this.runtimeState,
					this.operations,
					request,
					this.localRevision,
				),
		);
		this.history = new HistoryService({
			openSession: (path) =>
				open(path === undefined ? VAULT_SPACE : this.spaceFor(path)),
			enqueue: (task) => this.runtimeState.enqueue(task),
			refresh: () => this.operations.refreshNow(),
		});
		this.maintenance = new MaintenanceService({
			openSession: () => open(VAULT_SPACE),
			enqueue: (task) => this.runtimeState.enqueue(task),
			logInfo: (operation, message, details) =>
				this.host.logInfo(operation, message, details),
		});
	}

	getSnapshot(): SyncStatusSnapshot {
		return this.runtimeState.getSnapshot();
	}

	/** Current device identity for live-resolving history labels. */
	currentDevice(): { id: string; name: string } {
		const state = this.host.getState();
		return {
			id: state.deviceId,
			name: state.deviceName?.trim() || defaultDeviceName(),
		};
	}

	subscribe(listener: SyncStatusListener): () => void {
		return this.runtimeState.subscribe(listener);
	}

	/** Who last published the file, as its space's remote head says. */
	lastEdit(path: string): LastEdit | null {
		const remote = this.runtimeState.resultOf(this.spaceFor(path))?.remote;
		const entry = remote?.files[path];
		const author = authorOf(remote ?? null, entry);
		return entry && author ? { ...author, at: entry.mtime } : null;
	}

	/** Whether the path's space holds it remotely, as its last compare saw; null before one. */
	remoteHas(path: string): boolean | null {
		const remote = this.runtimeState.resultOf(this.spaceFor(path))?.remote;
		return remote ? remote.files[path] !== undefined : null;
	}

	dispose(): void {
		this.runtimeState.dispose();
		this.fileDiffs.clear();
		clearRemoteTextCache();
	}

	refresh(): Promise<void> {
		return this.refreshes.request();
	}

	/** The person's Refresh: the disk is listed too, for files Obsidian's index missed. */
	refreshFromDisk(): Promise<void> {
		this.operations.walkDiskNext();
		return this.refresh();
	}

	noteLocalChange(): void {
		this.localRevision++;
	}

	/** Before a share mounts into an empty folder, or once it closes; see `OperationRunner.forget`. */
	forgetSpace(
		space: Space,
		options?: { deleteRemote?: boolean },
	): Promise<void> {
		return this.operations.forget(space, options);
	}

	invalidate(reason: string): void {
		this.fileDiffs.clear();
		this.runtimeState.invalidate(reason);
	}

	/**
	 * A relay signal's pull; local changes elsewhere do not hold it back, a path changed on both sides is a
	 * conflict.
	 */
	refreshAndAutoPull(spaces?: ReadonlySet<string>): Promise<void> {
		return this.refreshes.request(spaces, true);
	}

	refreshAndAutoSync(push = true): Promise<void> {
		return this.refreshes.request(undefined, true, push);
	}

	refreshAndAutoPush(only?: ReadonlySet<string>): Promise<void> {
		return this.refreshes.request(undefined, false, true, only);
	}

	/** Compares and pushes only the shares containing these paths. */
	async autoPushShares(paths: ReadonlySet<string>): Promise<void> {
		// Routed by the records: a partition behind them, as before the first refresh, catches up first.
		const routed = pathsBySpace(this.runtimeState.spaces(), paths).keys();
		if ([...routed].some(({ id }) => id === VAULT_SPACE.id)) {
			await this.refresh();
		}
		for (const [space, group] of pathsBySpace(
			this.runtimeState.spaces(),
			paths,
		)) {
			if (space.id === VAULT_SPACE.id || space.readOnly || space.paused)
				continue;
			const only = new Set(group);
			await this.operations.runOperation(
				space,
				ESyncLogOperation.Push,
				(deps, result, ctx) => {
					const ready = selectAutoPushPaths(result.diff, only);
					return ready.length > 0
						? pushPathsOp(deps, result, ready, ctx)
						: Promise.resolve({
								newRemote: result.remote,
								touchedPaths: new Set<string>(),
							});
				},
			);
		}
	}

	/** The space `path` belongs to, as the last refresh partitioned the vault. */
	spaceFor(path: string): Space {
		return spaceOf(this.runtimeState.spaces(), path);
	}

	async resetRemoteStorage(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runResetRemoteStorageFlow(deps, ctx),
		);
	}

	async resetCategory(
		category: keyof SettingsSyncCategories,
	): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Reset, (deps, ctx) =>
			runCategoryResetFlow(deps, ctx, category),
		);
	}

	async adoptNewVault(): Promise<boolean> {
		return this.operations.runFlow(ESyncLogOperation.Compare, (deps, ctx) =>
			runAdoptNewVaultFlow(deps, ctx),
		);
	}

	/** Runs between operations: none still running persists over what `task` writes. */
	between<T>(task: () => Promise<T>): Promise<T> {
		return this.runtimeState.enqueue(task);
	}

	/** Stops the running operation between files; see `sync/cancel.ts`. */
	cancel(): void {
		this.runtimeState.cancel();
	}

	/** Refused whole when any path is in a read-only share: its owner's relay would refuse it, Revert drops it. */
	async pushPaths(paths: ReadonlyArray<string>): Promise<SyncOperationResult> {
		if (paths.some((path) => this.spaceFor(path).readOnly)) {
			return { ok: false, error: READ_ONLY_PUSH };
		}
		return this.perSpace(
			ESyncLogOperation.Push,
			paths,
			(group) => (deps, result, ctx) => pushPathsOp(deps, result, group, ctx),
			true,
		);
	}

	async pullPaths(paths: ReadonlyArray<string>): Promise<SyncOperationResult> {
		return this.perSpace(
			ESyncLogOperation.Pull,
			paths,
			(group) => (deps, result, ctx) => pullPathsOp(deps, result, group, ctx),
			true,
		);
	}

	/** Pushes and reverts segments of one local-change diff in a single operation. */
	async applyLocalHunks(args: LocalHunksArgs): Promise<SyncOperationResult> {
		if (args.push.size === 0 && args.revert.size === 0) return { ok: false };
		if (args.push.size > 0 && this.spaceFor(args.path).readOnly) {
			return { ok: false, error: READ_ONLY_PUSH };
		}
		return this.operations.runOperation(
			this.spaceFor(args.path),
			args.push.size > 0 ? ESyncLogOperation.Push : ESyncLogOperation.Compare,
			(deps, result, ctx) => localHunksOp(deps, result, args, ctx),
		);
	}

	async pushHunks(
		path: string,
		selected: HunkSelection,
		expected?: HunkSidesHash,
	): Promise<SyncOperationResult> {
		return this.applyLocalHunks({
			path,
			push: selected,
			revert: new Map(),
			expected,
		});
	}

	async pullHunks(
		path: string,
		selected: HunkSelection,
		expected?: HunkSidesHash,
	): Promise<SyncOperationResult> {
		if (selected.size === 0) return { ok: false };
		return this.operations.runOperation(
			this.spaceFor(path),
			ESyncLogOperation.Pull,
			(deps, result, ctx) =>
				pullHunksOp(deps, result, { path, selected, expected }, ctx),
		);
	}

	async revertPaths(
		paths: ReadonlyArray<string>,
	): Promise<SyncOperationResult> {
		return this.perSpace(
			ESyncLogOperation.Compare,
			paths,
			(group) => (deps, result, ctx) => revertPathsOp(deps, result, group, ctx),
		);
	}

	/** Keeps the local file and parks the remote version beside it as a conflict copy, published with the next push. */
	async resolveConflictKeepBoth(path: string): Promise<SyncOperationResult> {
		return this.operations.runOperation(
			this.spaceFor(path),
			ESyncLogOperation.Push,
			(deps, res, ctx) => keepBothConflictOp(deps, res, path, ctx),
		);
	}

	async resolveConflicts(
		paths: ReadonlyArray<string>,
		strategy: EConflictStrategy,
	): Promise<SyncOperationResult> {
		const { op, logOp } = CONFLICT_STRATEGY_OPS[strategy];
		return this.perSpace(
			logOp,
			new Set(paths),
			(group) => (deps, result, ctx) => op(deps, result, new Set(group), ctx),
		);
	}

	/** Writes the user-merged content locally and pushes it immediately, unlike auto-merge. */
	async resolveConflictMerged(
		path: string,
		content: string,
		expected: MergedSaveArgs["expected"],
	): Promise<SyncOperationResult> {
		return this.operations.runOperation(
			this.spaceFor(path),
			ESyncLogOperation.Push,
			(deps, res, ctx) =>
				saveMergedOp(deps, res, { path, content, expected }, ctx),
		);
	}

	/** A share that lost every file here: they come back from it, or their loss reaches everyone. */
	async settleGone(
		space: Space,
		choice: "restore" | "delete",
	): Promise<SyncOperationResult> {
		if (choice === "restore") {
			// Mounted afresh, nothing reads as deleted: the share's files pull back in.
			await this.operations.forget(space);
			await this.refreshAndAutoPull(new Set([space.id]));
			const { error, spaceErrors } = this.getSnapshot();
			const failed =
				error ?? spaceErrors.find(({ root }) => root === space.root)?.message;
			return failed ? { ok: false, error: failed } : { ok: true };
		}
		const outcome = await this.operations.runOperation(
			{ ...space, goneAccepted: true },
			ESyncLogOperation.Push,
			(deps, result, ctx) =>
				pushPathsOp(
					deps,
					result,
					result.diff.localChanges.map(({ path }) => path),
					ctx,
				),
			true,
		);
		await this.refresh();
		return outcome;
	}

	/** One operation per space the paths fall in; stops at the first that fails. */
	private async perSpace(
		operation: ESyncLogOperation,
		paths: Iterable<string>,
		bind: (group: string[]) => SpaceOperation,
		cancellable = false,
	): Promise<SyncOperationResult> {
		let outcome: SyncOperationResult = { ok: false };
		for (const [space, group] of pathsBySpace(
			this.runtimeState.spaces(),
			paths,
		)) {
			outcome = await this.operations.runOperation(
				space,
				operation,
				bind(group),
				cancellable,
			);
			if (!outcome.ok) break;
		}
		return outcome;
	}
}
