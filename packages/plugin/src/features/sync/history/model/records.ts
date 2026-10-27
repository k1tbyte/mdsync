import { composeChanges } from "../changes";
import type { SnapshotChanges } from "../types";
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

/** Chain order, oldest first, as `records` are: one record per span, over contiguous runs only. */
export function thin(
	records: readonly StoredRecord[],
	res: Resolution,
): StoredRecord[] {
	const thinned: StoredRecord[] = [];
	let run: StoredRecord[] = [];
	let runSpan: number | null = null;
	for (const record of records) {
		const span = keepStart(res, record.at);
		const previous = run.at(-1);
		if (
			previous &&
			span !== null &&
			span === runSpan &&
			record.parentId === previous.id
		) {
			run.push(record);
			continue;
		}
		if (run.length > 0) thinned.push(mergeRecords(run));
		run = [record];
		runSpan = span;
	}
	if (run.length > 0) thinned.push(mergeRecords(run));
	return thinned;
}

/** `run` is contiguous, oldest first. */
export function mergeRecords(run: readonly StoredRecord[]): StoredRecord {
	const [first] = run;
	const last = run.at(-1);
	if (!first || !last) throw new Error("Cannot merge an empty run.");
	if (run.length === 1) return first;
	const activity: Activity = {};
	for (const record of run) addActivity(activity, record.activity);
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

export function addActivity(into: Activity, add: Activity): void {
	for (const [hour, [pushes, paths]] of Object.entries(add)) {
		const was = into[Number(hour)] ?? [0, 0];
		into[Number(hour)] = [was[0] + pushes, was[1] + paths];
	}
}

function pathsChanged(changes: SnapshotChanges): number {
	return (
		Object.keys(changes.added).length +
		Object.keys(changes.modified).length +
		Object.keys(changes.deleted).length
	);
}
