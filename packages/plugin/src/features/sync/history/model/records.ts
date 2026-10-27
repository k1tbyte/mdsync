import { composeChanges } from "../changes";
import type { SnapshotChanges } from "../types";
import { mergeActivity } from "./activity";
import { hourOf, keepStart } from "./periods";
import type { Activity, PushRecord, Resolution, StoredRecord } from "./types";

/** A push as stored once storage has dated it. */
export function storedRecord(push: PushRecord, at: number): StoredRecord {
	return {
		id: push.id,
		parentId: push.parentId,
		createdAt: push.createdAt,
		deviceId: push.deviceId,
		deviceName: push.deviceName,
		changes: push.changes,
		at,
		firstAt: at,
		pushes: 1,
		activity: { [hourOf(at)]: [1, pathsChanged(push.changes)] },
	};
}

/** Splits records, in order, wherever `joins` fails; by default at every break in the chain. */
export function runsOf(
	records: readonly StoredRecord[],
	joins = (previous: StoredRecord, record: StoredRecord): boolean =>
		record.parentId === previous.id,
): StoredRecord[][] {
	const runs: StoredRecord[][] = [];
	for (const record of records) {
		const run = runs.at(-1);
		const previous = run?.at(-1);
		if (run && previous && joins(previous, record)) run.push(record);
		else runs.push([record]);
	}
	return runs;
}

/** Chain order, oldest first, as `records` are: one record per span, over contiguous runs only. */
export function thin(
	records: readonly StoredRecord[],
	res: Resolution,
): StoredRecord[] {
	return runsOf(records, (previous, record) => {
		const span = keepStart(res, record.at);
		return (
			span !== null &&
			span === keepStart(res, previous.at) &&
			record.parentId === previous.id
		);
	}).map(mergeRecords);
}

/** `run` is contiguous, oldest first. */
export function mergeRecords(run: readonly StoredRecord[]): StoredRecord {
	const [first] = run;
	const last = run.at(-1);
	if (!first || !last) throw new Error("Cannot merge an empty run.");
	if (run.length === 1) return first;
	const activity: Activity = {};
	for (const record of run) mergeActivity(activity, record.activity);
	return {
		id: last.id,
		parentId: first.parentId,
		createdAt: last.createdAt,
		deviceId: last.deviceId,
		deviceName: last.deviceName,
		changes: composeChanges(run.map((record) => record.changes)),
		at: Math.max(...run.map((record) => record.at)),
		firstAt: Math.min(...run.map((record) => record.firstAt)),
		pushes: run.reduce((sum, record) => sum + record.pushes, 0),
		activity,
	};
}

function pathsChanged(changes: SnapshotChanges): number {
	return (
		Object.keys(changes.added).length +
		Object.keys(changes.modified).length +
		Object.keys(changes.deleted).length
	);
}
