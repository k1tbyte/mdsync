import { describe, expect, it, vi } from "vitest";
import type { CompareResult } from "@/features/sync/engine";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import { SyncControllerRuntimeState } from "@/features/sync/runtime/controller-state";

describe("SyncControllerRuntimeState.publishProgress", () => {
	it("carries the ratio of a counted step and clears it with the text", () => {
		const state = new SyncControllerRuntimeState();

		state.publishProgress("Pushing 1/4…", 0.25);
		expect(state.getSnapshot().progressRatio).toBe(0.25);

		state.publishProgress(null);
		expect(state.getSnapshot().progressRatio).toBeNull();
	});
});

describe("SyncControllerRuntimeState.dispose", () => {
	it("drops the compare result, which unload leaves reachable otherwise", () => {
		const state = new SyncControllerRuntimeState();
		state.setResult(VAULT_SPACE, {
			diff: { localChanges: [], remoteChanges: [], conflicts: [] },
		} as unknown as CompareResult);
		state.setError("boom");
		state.setProgressText("Pushing 1/2…");

		state.dispose();

		const snapshot = state.getSnapshot();
		expect(snapshot.result).toBeNull();
		expect(snapshot.error).toBeNull();
		expect(snapshot.progressText).toBeNull();
	});
});

describe("SyncControllerRuntimeState.enqueueQuiet", () => {
	it("keeps order with enqueue and never flips busy", async () => {
		const state = new SyncControllerRuntimeState();
		const busy: boolean[] = [];
		state.subscribe((snapshot) => busy.push(snapshot.busy));
		const order: string[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const held = state.enqueue(async () => {
			await gate;
			order.push("operation");
		});
		const quiet = state.enqueueQuiet(async () => {
			order.push("quiet");
		});
		release();
		await Promise.all([held, quiet]);
		expect(order).toEqual(["operation", "quiet"]);

		busy.length = 0;
		await state.enqueueQuiet(async () => {
			order.push("alone");
		});
		expect(state.getSnapshot().busy).toBe(false);
		expect(busy).toEqual([]);
	});

	it("runs the next task after one that failed", async () => {
		const state = new SyncControllerRuntimeState();
		const failed = state.enqueueQuiet(async () => {
			throw new Error("boom");
		});
		await expect(failed).rejects.toThrow("boom");
		await expect(state.enqueueQuiet(async () => "ok")).resolves.toBe("ok");
	});
});

describe("SyncControllerRuntimeState.patchResult", () => {
	it("replaces a space's result and keeps the compare time and space errors", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const state = new SyncControllerRuntimeState();
			state.setResult(VAULT_SPACE, resultWith("before"));
			state.setSpaceErrors([{ root: "Team", message: "offline" }]);

			vi.setSystemTime(5_000);
			const patched = resultWith("after");
			state.patchResult(VAULT_SPACE, patched);

			const snapshot = state.getSnapshot();
			expect(snapshot.result).toBe(patched);
			expect(snapshot.lastCompareAt).toBe(1_000);
			expect(snapshot.spaceErrors).toEqual([
				{ root: "Team", message: "offline" },
			]);
			expect(state.resultOf(VAULT_SPACE)).toBe(patched);
		} finally {
			vi.useRealTimers();
		}
	});
});

function resultWith(path: string): CompareResult {
	return {
		diff: {
			localChanges: [{ path }],
			remoteChanges: [],
			conflicts: [],
			moves: [],
		},
	} as unknown as CompareResult;
}
