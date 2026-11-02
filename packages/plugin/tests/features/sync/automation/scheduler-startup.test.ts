import {
	type SchedulerOptions,
	schedulerHarness,
} from "@tests/helpers/scheduler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function harness(
	state: Omit<SchedulerOptions, "settings"> & { autosync?: boolean },
) {
	const { autosync, ...options } = state;
	return schedulerHarness({
		compared: false,
		...options,
		settings: {
			autoSyncEnabled: autosync ?? true,
			autoSyncIntervalMinutes: 10,
		},
	});
}

describe("startup autosync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("waits for the metadata cache while it is still filling", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.syncs()).toBe(0);

		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.syncs()).toBe(1);

		// The event keeps firing as the vault changes; the first run is the only one.
		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.syncs()).toBe(1);
	});

	it("runs anyway when the cache never reports itself settled", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(1);
	});

	it("keeps the short delay for a cache that settled before it registered", async () => {
		const h = harness({ layoutReady: false, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
	});

	it("keeps the short delay for a plugin enabled by hand", async () => {
		const h = harness({ layoutReady: true, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
	});

	it("does not run after unload", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		h.unload();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(0);
	});

	it("only compares at startup when autosync is off", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(0);
		expect(h.compares()).toBe(1);
	});

	it("waits for the metadata cache before that compare too", async () => {
		const h = harness({
			layoutReady: false,
			initialized: false,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.compares()).toBe(0);
		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.compares()).toBe(1);
	});

	it("never asks for a passphrase on launch to compare", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			savedPassphrase: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("skips the compare when the saved passphrase no longer opens the vault", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			rotated: true,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("leaves a compare that already ran alone", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			compared: true,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("does not compare offline", async () => {
		vi.stubGlobal("navigator", { onLine: false });
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});
});
