import { DAY } from "@tests/helpers/history-sim";
import { expect, it } from "vitest";
import { activityOf } from "@/features/sync/history/model/activity";
import type { HistoryView } from "@/features/sync/history/model/cover";
import { storedRecord } from "@/features/sync/history/model/records";
import type {
	Activity,
	HistoryObject,
} from "@/features/sync/history/model/types";

function counts(group: number, activity: Activity) {
	const object: HistoryObject = {
		v: 1,
		vaultId: "vault",
		res: "counts",
		group,
		records: [],
		activity,
		consumed: [],
	};
	return { object, at: 0 };
}

it("takes the larger of two counts of one group per hour, and adds other groups", () => {
	const view: HistoryView = {
		pushes: new Map(),
		objects: new Map([
			["b/1", counts(0, { 1: [2, 5], 2: [1, 1] })],
			["b/2", counts(0, { 1: [3, 4] })],
			["b/3", counts(28 * DAY, { 700: [1, 1] })],
		]),
	};
	const cover = {
		chain: [],
		lagging: false,
		truncated: false,
		consumed: new Set<string>(),
	};
	expect(activityOf(view, cover, "vault")).toEqual({
		1: [3, 5],
		2: [1, 1],
		700: [1, 1],
	});
});

it("takes a record walked into counted hours as another view of the same pushes", () => {
	const at = Date.UTC(2026, 0, 6, 10);
	const record = storedRecord(
		{
			v: 1,
			vaultId: "vault",
			id: "a",
			parentId: null,
			createdAt: at,
			deviceId: "d",
			changes: { added: {}, modified: {}, deleted: {} },
		},
		at,
	);
	const view: HistoryView = {
		pushes: new Map(),
		objects: new Map([["b/1", counts(0, record.activity)]]),
	};
	const cover = {
		chain: [{ record, source: "b/week" }],
		lagging: false,
		truncated: false,
		consumed: new Set<string>(),
	};
	expect(activityOf(view, cover, "vault")).toEqual(record.activity);
});
