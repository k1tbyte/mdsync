import { describe, expect, it } from "vitest";

import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";
import {
	RefreshQueue,
	type RefreshRequest,
} from "@/sync/runtime/refresh-queue";
import { VAULT_SPACE } from "@/sync/space";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("refresh request coalescing", () => {
	it("keeps one active and one pending turn, with a vault signal dominating share targets", async () => {
		const state = new SyncControllerRuntimeState();
		const started = deferred();
		const released = deferred();
		const requests: RefreshRequest[] = [];
		const queue = new RefreshQueue(
			(run) => state.enqueue(run),
			async (request) => {
				requests.push(request);
				if (requests.length === 1) {
					started.resolve();
					await released.promise;
				}
			},
		);
		const active = queue.request(new Set(["a"]), true);
		await started.promise;
		const pending = queue.request(new Set(["b"]), true);
		for (let index = 0; index < 100; index++)
			expect(queue.request(new Set(["c"]), true)).toBe(pending);
		expect(queue.request(new Set([VAULT_SPACE.id]), false, true)).toBe(pending);
		released.resolve();
		await Promise.all([active, pending]);
		expect(requests).toEqual([
			{ spaces: new Set(["a"]), pull: true, push: false, only: undefined },
			{ spaces: null, pull: true, push: true, only: undefined },
		]);
		state.dispose();
	});

	it("unions share targets and queued push paths without a full request", async () => {
		const state = new SyncControllerRuntimeState();
		const requests: RefreshRequest[] = [];
		const queue = new RefreshQueue(
			(run) => state.enqueue(run),
			async (request) => {
				requests.push(request);
			},
		);
		const a = queue.request(new Set(["a"]), false, true, new Set(["a/x"]));
		const b = queue.request(new Set(["b"]), false, true, new Set(["b/y"]));
		expect(b).toBe(a);
		await a;
		expect(requests[0]).toEqual({
			spaces: new Set(["a", "b"]),
			pull: false,
			push: true,
			only: new Set(["a/x", "b/y"]),
		});
		state.dispose();
	});
});
