import { ESyncLogOperation } from "@/logs/store";
import type { SettingsSyncCategories } from "@/settings/model";
import { writeBinary } from "@/vault/io";
import { authorOf, type LastEdit } from "./authors";
import { autoMergeOp } from "./auto-merge";
import { selectAutoPushPaths } from "./auto-push";
import { clearRemoteTextCache, textToBytes } from "./content";
import { defaultDeviceName } from "./device";
import type { CompareResult, EngineDependencies } from "./engine";
import type { HunkSelection } from "./hunks";
import {
	batchAcceptRemoteOp,
	batchKeepLocalOp,
	type HunkSidesHash,
	keepBothConflictOp,
	type LocalHunksArgs,
	localHunksOp,
	type Operation,
	pullHunksOp,
	pullPathsOp,
	pushPathsOp,
	revertPathsOp,
	runAdoptNewVaultFlow,
	runResetRemoteStorageFlow,
	type SyncOperationResult,
} from "./operations";
import { runCategoryResetFlow } from "./operations/config-reset";
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
	 * The vault first. Asked once per refresh: the partition holds until the
	 * next. Null when the vault cannot open, which ends the refresh.
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
	readonly history: HistoryService;
	readonly maintenance: MaintenanceService;

	constructor(host: SyncControllerHost) {
		this.host = host;
		this.runtimeState = new SyncControllerRuntimeState();
		const open = (space: Space) =>
			this.host.openSession(space, this.runtimeState.spaces());
		this.fileDiffs = new FileDiffService({
			openSession: (path) => open(this.spaceFor(path)),
			getResult: () => this.runtimeState.getResult(),
		});
		this.operations = new OperationRunner({
			host: this.host,
			runtimeState: this.runtimeState,
			clearFileDiffs: () => this.fileDiffs.clear(),
		});
		this.history = new HistoryService({
			openSession: (path) =>
				open(path === undefined ? VAULT_SPACE : this.spaceFor(path)),
			enqueue: (task) => this.runtimeState.enqueue(task),
			refresh: () => this.operations.refreshNow(),
		});
		this.maintenance = new MaintenanceService({
			openSession: () => open(VAULT_SPACE),
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

	dispose(): void {
		this.runtimeState.dispose();
		this.fileDiffs.clear();
		clearRemoteTextCache();
	}

	async refresh(): Promise<void> {
		await this.operations.refresh();
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

	async refreshAndAutoPull(): Promise<void> {
		const afterMerge = await this.refreshAndAutoMerge();
		if (!afterMerge) return;
		if (afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.localChanges.length > 0) return;
		if (afterMerge.diff.remoteChanges.length === 0) return;
		await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
	}

	async refreshAndAutoSync(push = true): Promise<void> {
		const afterMerge = await this.refreshAndAutoMerge();
		if (!afterMerge || afterMerge.diff.conflicts.length > 0) return;
		if (afterMerge.diff.remoteChanges.length > 0) {
			await this.pullPaths(afterMerge.diff.remoteChanges.map((c) => c.path));
		}
		const snapshot = this.runtimeState.getSnapshot();
		if (snapshot.error || snapshot.staleReason) return;
		if (!push) return;
		await this.autoPushFromSnapshot();
	}

	async refreshAndAutoPush(): Promise<void> {
		await this.refresh();
		await this.autoPushFromSnapshot();
	}

	/**
	 * Pushes pending local changes from the current snapshot. Conflicts and
	 * files with incoming remote changes are left for the user to settle.
	 */
	async autoPushFromSnapshot(only?: ReadonlySet<string>): Promise<void> {
		if (this.runtimeState.getSnapshot().error) return;
		const result = this.runtimeState.getResult();
		if (!result) return;
		const paths = selectAutoPushPaths(result.diff, only).filter(
			(path) => !this.spaceFor(path).readOnly,
		);
		if (paths.length === 0) return;
		await this.pushPaths(paths);
	}

	private async autoMerge(): Promise<void> {
		for (const space of this.runtimeState.spaces()) {
			const conflicts = this.runtimeState.resultOf(space)?.diff.conflicts;
			if ((conflicts?.length ?? 0) === 0) continue;
			await this.operations.runOperation(
				space,
				ESyncLogOperation.Pull,
				autoMergeOp,
			);
		}
	}

	private async refreshAndAutoMerge(): Promise<CompareResult | null> {
		await this.refresh();
		const result = this.runtimeState.getResult();
		if (!result) return null;
		if (result.diff.conflicts.length > 0) await this.autoMerge();
		return this.runtimeState.getResult();
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

	/** Stops the running operation between files; see `sync/cancel.ts`. */
	cancel(): void {
		this.runtimeState.cancel();
	}

	/** Refused whole when any path is in a read-only share: its owner's relay would refuse it, Revert drops it. */
	async pushPaths(paths: ReadonlyArray<string>): Promise<SyncOperationResult> {
		if (paths.some((path) => this.spaceFor(path).readOnly)) {
			return {
				ok: false,
				error:
					"Files in a read-only shared folder cannot be pushed. Revert them to drop the changes.",
			};
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

	/**
	 * Resolves a conflict by keeping the local file and parking the remote
	 * version beside it as a conflict copy, which publishes with the next push.
	 */
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

	/**
	 * Resolves conflict with user-merged content: writes locally, then keeps
	 * local side - uploading the file and publishing a manifest.
	 * Unlike auto-merge, this pushes immediately.
	 */
	async resolveConflictMerged(
		path: string,
		content: string,
	): Promise<SyncOperationResult> {
		return this.operations.runOperation(
			this.spaceFor(path),
			ESyncLogOperation.Push,
			async (deps, res, ctx) => {
				await writeBinary(deps.adapter, path, textToBytes(content));
				return batchKeepLocalOp(deps, res, new Set([path]), ctx);
			},
		);
	}

	private spaceFor(path: string): Space {
		return spaceOf(this.runtimeState.spaces(), path);
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
