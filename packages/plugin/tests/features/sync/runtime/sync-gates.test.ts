import { describe, expect, it } from "vitest";
import type { SyncStatusSnapshot } from "@/features/sync/controller";
import type { CompareResult } from "@/features/sync/engine";
import { canPullAll, canPushAll } from "@/features/sync/runtime/sync-gates";
import {
	type Conflict,
	type DiffResult,
	EChangeType,
	type FileChange,
} from "@/features/sync/types";

interface Input {
	busy?: boolean;
	offline?: boolean;
	/** No comparison has landed. */
	uncompared?: boolean;
	local?: number;
	remote?: number;
	conflicts?: number;
}

function change(side: "local" | "remote", index: number): FileChange {
	return {
		path: `${side}-${index}.md`,
		type: side === "local" ? EChangeType.LocalModify : EChangeType.RemoteModify,
		localHash: "l",
		remoteHash: "r",
	};
}

function snapshot(input: Input): SyncStatusSnapshot {
	const count = (n = 0) => Array.from({ length: n }, (_, index) => index);
	const conflicts: Conflict[] = count(input.conflicts).map((index) => ({
		path: `both-${index}.md`,
		localHash: "l",
		remoteHash: "r",
		baselineHash: "b",
	}));
	const diff: DiffResult = {
		localChanges: count(input.local).map((i) => change("local", i)),
		remoteChanges: count(input.remote).map((i) => change("remote", i)),
		conflicts,
		moves: [],
		converged: [],
		remoteMoved: false,
	};
	const result = input.uncompared
		? null
		: ({ diff } as Pick<CompareResult, "diff"> as CompareResult);
	return {
		busy: input.busy ?? false,
		offline: input.offline ?? false,
		result,
	} as SyncStatusSnapshot;
}

const CASES: Array<[string, Input, boolean, boolean]> = [
	["only local changes", { local: 2 }, true, false],
	["only remote changes", { remote: 2 }, false, true],
	["changes on both sides", { local: 1, remote: 1 }, false, true],
	["nothing to move", {}, false, false],
	["a conflict beside local changes", { local: 1, conflicts: 1 }, false, false],
	[
		"a conflict beside remote changes",
		{ remote: 1, conflicts: 1 },
		false,
		false,
	],
	["no comparison yet", { uncompared: true }, false, false],
	[
		"an operation running over local changes",
		{ local: 1, busy: true },
		false,
		false,
	],
	[
		"an operation running over remote changes",
		{ remote: 1, busy: true },
		false,
		false,
	],
	["no connection to local changes", { local: 1, offline: true }, false, false],
	[
		"no connection to remote changes",
		{ remote: 1, offline: true },
		false,
		false,
	],
];

describe("canPushAll and canPullAll", () => {
	it.each(CASES)("push with %s", (_, input, push) => {
		expect(canPushAll(snapshot(input))).toBe(push);
	});

	it.each(CASES)("pull with %s", (_, input, _push, pull) => {
		expect(canPullAll(snapshot(input))).toBe(pull);
	});
});
