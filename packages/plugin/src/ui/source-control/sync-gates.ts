/** Whether Push all / Pull all may run now; the summary card and the status menu agree on it. */
import type { SyncStatusSnapshot } from "@/sync/controller";

export function canPushAll(snapshot: SyncStatusSnapshot): boolean {
	const diff = snapshot.result?.diff;
	return (
		!snapshot.busy &&
		!!diff &&
		diff.conflicts.length === 0 &&
		diff.remoteChanges.length === 0 &&
		diff.localChanges.length > 0
	);
}

export function canPullAll(snapshot: SyncStatusSnapshot): boolean {
	const diff = snapshot.result?.diff;
	return (
		!snapshot.busy &&
		!!diff &&
		diff.conflicts.length === 0 &&
		diff.remoteChanges.length > 0
	);
}
