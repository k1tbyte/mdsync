import type { Cover, HistoryView } from "./cover";
import type { Activity } from "./types";

const sum = (a: number, b: number): number => a + b;

export function mergeActivity(
	into: Activity,
	add: Activity,
	combine = sum,
): void {
	for (const [hour, [pushes, paths]] of Object.entries(add)) {
		const was = into[Number(hour)];
		into[Number(hour)] = was
			? [combine(was[0], pushes), combine(was[1], paths)]
			: [pushes, paths];
	}
}

/** The walk's records plus what counts objects outlived. */
export function activityOf(
	view: HistoryView,
	cover: Cover,
	vaultId: string,
): Activity {
	const activity: Activity = {};
	for (const { record } of cover.chain) {
		mergeActivity(activity, record.activity);
	}
	for (const [key, { object }] of view.objects) {
		if (object.res !== "counts" || object.vaultId !== vaultId) continue;
		if (!cover.consumed.has(key)) mergeCounts(activity, object.activity ?? {});
	}
	return activity;
}

/**
 * Counts hold hours past the horizon: another counts of them, or a record walked there until GC folds it in,
 * is another view of the same pushes. Per hour the larger stands, never the sum.
 */
export function mergeCounts(into: Activity, other: Activity): void {
	mergeActivity(into, other, Math.max);
}
