import { ESyncLogOperation } from "@/logs/store";
import { autoMergeOp } from "@/sync/auto-merge";
import { selectAutoPushPaths } from "@/sync/auto-push";
import { pullPathsOp, pushPathsOp } from "@/sync/operations";

import type { SyncControllerRuntimeState } from "./controller-state";
import type { OperationRunner, SpaceOperation } from "./operation-runner";
import type { RefreshRequest } from "./refresh-queue";

export async function runRefreshCycle(
	runtime: SyncControllerRuntimeState,
	operations: OperationRunner,
	request: RefreshRequest,
	revision: number,
): Promise<void> {
	const before = runtime.getSnapshot();
	const targets =
		!before.result || before.staleReason || before.error
			? null
			: request.spaces;
	const epoch = runtime.currentEpoch();
	await operations.refreshNow(targets);
	const snapshot = runtime.getSnapshot();
	if (
		snapshot.error ||
		snapshot.staleReason ||
		(!request.pull && !request.push)
	)
		return;
	for (const space of runtime.spaces()) {
		if (space.paused || (targets !== null && !targets.has(space.id))) continue;
		const run = async (
			operation: ESyncLogOperation,
			fn: SpaceOperation,
		): Promise<boolean> => {
			const result = runtime.resultOf(space);
			if (!result || runtime.currentEpoch() !== epoch) return false;
			return (
				await operations.runOperationNow(space, operation, fn, true, {
					result,
					epoch,
					revision,
				})
			).ok;
		};
		let result = runtime.resultOf(space);
		if (!result) continue;
		if (request.pull && result.diff.conflicts.length > 0) {
			if (!(await run(ESyncLogOperation.Pull, autoMergeOp))) return;
			result = runtime.resultOf(space);
		}
		if (!result || result.diff.conflicts.length > 0) continue;
		if (request.pull && result.diff.remoteChanges.length > 0) {
			if (
				!(await run(ESyncLogOperation.Pull, (deps, compared, ctx) =>
					pullPathsOp(
						deps,
						compared,
						compared.diff.remoteChanges.map((change) => change.path),
						ctx,
					),
				))
			)
				return;
		}
		if (!request.push || space.readOnly) continue;
		result = runtime.resultOf(space);
		if (!result || selectAutoPushPaths(result.diff, request.only).length === 0)
			continue;
		if (
			!(await run(ESyncLogOperation.Push, (deps, compared, ctx) =>
				pushPathsOp(
					deps,
					compared,
					selectAutoPushPaths(compared.diff, request.only),
					ctx,
				),
			))
		)
			return;
	}
}
