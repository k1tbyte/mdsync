import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { Outbox } from "@/features/live/session/outbox";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function outbox(every = 250) {
	const shipped: Uint8Array[] = [];
	const interval = { every };
	const box = new Outbox({
		enqueue: (step) => void step(),
		ship: async (update) => {
			shipped.push(update);
		},
		settle: async () => {},
		every: () => interval.every,
		online: () => true,
	});
	return { box, shipped, interval };
}

const doc = new Y.Doc();

function edit(): Uint8Array {
	let update: Uint8Array = new Uint8Array();
	doc.once("update", (made: Uint8Array) => {
		update = made;
	});
	doc.getText("body").insert(0, "x");
	return update;
}

describe("live outbox", () => {
	it("sends a change at once and what follows in one send an interval after it", async () => {
		const { box, shipped } = outbox();

		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(0);
		expect(shipped).toHaveLength(1);

		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(100);
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(149);
		expect(shipped).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(shipped).toHaveLength(2);
	});

	it("waits only for the rest of the interval", async () => {
		const { box, shipped } = outbox();
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(200);

		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(50);

		expect(shipped).toHaveLength(2);
	});

	it("sends at once again after an interval with no change", async () => {
		const { box, shipped } = outbox();

		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(250);
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(0);

		expect(shipped).toHaveLength(2);
	});

	it("takes a changed interval from the next wait", async () => {
		const { box, shipped, interval } = outbox(1000);
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(0);
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(999);
		expect(shipped).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);

		interval.every = 100;
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(100);

		expect(shipped).toHaveLength(3);
	});

	it("starts no interval from a stage that changed nothing", async () => {
		const { box, shipped } = outbox(1000);
		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(0);
		box.stage(() => {});
		await vi.advanceTimersByTimeAsync(1001);

		box.addPending(edit());
		await vi.advanceTimersByTimeAsync(0);

		expect(shipped).toHaveLength(2);
	});

	it("drains a stage after a quiet interval on the next task, not inside the call", async () => {
		const { box } = outbox();
		const drain = vi.fn();

		box.stage(drain);
		expect(drain).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);

		expect(drain).toHaveBeenCalledOnce();
	});
});
