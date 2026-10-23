import { describe, expect, it } from "vitest";
import type { CompareResult } from "@/sync/engine";
import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";
import { VAULT_SPACE } from "@/sync/space";

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
