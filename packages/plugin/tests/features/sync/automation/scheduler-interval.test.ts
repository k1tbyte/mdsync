import {
	type SchedulerHarness,
	schedulerHarness,
} from "@tests/helpers/scheduler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MdsyncSettings } from "@/core/settings";
import { SCHEDULER_HEARTBEAT_MS } from "@/features/sync/automation/scheduler";

const MINUTE_MS = 60_000;

function harness(
	settings: Pick<MdsyncSettings, "autoSyncIntervalMinutes"> &
		Partial<MdsyncSettings>,
) {
	return schedulerHarness({
		settings: { autoSyncEnabled: true, autoPushAfterChange: true, ...settings },
	});
}

describe("auto-sync intervals", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("runs a full sync on its interval", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("does nothing before the interval is due", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 30_001);
		expect(h.syncs()).toBe(1);
	});

	it("never fires while autosync is disabled", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10, autoSyncEnabled: false });
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(0);
	});

	it("syncs only once after startup when the interval is zero", async () => {
		const h = harness({ autoSyncIntervalMinutes: 0 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
	});

	it("passes the push preference into the sync cycle", async () => {
		const h = harness({
			autoSyncIntervalMinutes: 10,
			autoPushAfterSync: false,
		});
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.pushFlags()).toEqual([false]);
		const full = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(full.pushFlags()).toEqual([true]);
	});

	it("applies a shortened interval without a restart", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
		h.host.settings.autoSyncIntervalMinutes = 1;
		await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("defers a due cycle that follows a manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		// The user finishes a manual sync shortly before the tick is due.
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 15_000 - 3_000);
		h.manualSync();
		// The due tick is suppressed and retries after the cooldown, not a
		// whole interval later.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(2);
	});

	it("recovers from error backoff after a successful manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 1 });
		h.setSyncError("backend down");
		// Failures at 3s, 60s and 120s arm the backoff until 240s: the 180s tick is suppressed, the 240s
		// one fails again and extends it to 480s.
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.advanceTimersByTimeAsync(57_000);
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(4);
		// The user fixes the backend and syncs by hand.
		h.setSyncError(null);
		await vi.advanceTimersByTimeAsync(35_000);
		h.manualSync();
		// The due tick defers to the manual cycle, then runs with the backoff
		// cleared instead of waiting out the remaining 3 minutes.
		await vi.advanceTimersByTimeAsync(25_000);
		expect(h.syncs()).toBe(4);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(5);
	});

	it("releases a push held by the backoff once a clean sync ends it", async () => {
		const h = harness({ autoSyncIntervalMinutes: 1 });
		const settle = h.host.settings.autoPushSettleSeconds * 1000;
		h.setSyncError("backend down");
		// Failures at 3s, 60s and 120s arm the backoff until 240s.
		await vi.advanceTimersByTimeAsync(120_000);
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(settle);
		expect(h.pushes()).toHaveLength(0);

		h.setSyncError(null);
		h.manualSync();
		await vi.advanceTimersByTimeAsync(settle);
		expect(h.pushes()).toHaveLength(1);
	});

	describe("when the connection returns", () => {
		const dropAndRestore = async (h: SchedulerHarness): Promise<void> => {
			vi.stubGlobal("navigator", { onLine: false });
			h.fire("offline");
			await vi.advanceTimersByTimeAsync(5_000);
			vi.stubGlobal("navigator", { onLine: true });
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
		};

		it("syncs at once instead of waiting out the interval", async () => {
			const h = harness({ autoSyncIntervalMinutes: 60 });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(1);

			await dropAndRestore(h);

			expect(h.syncs()).toBe(2);
			expect(h.connectivityChanges()).toBe(2);
		});

		it("only compares when autosync is off", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});

			await dropAndRestore(h);

			expect(h.compares()).toBe(1);
			expect(h.syncs()).toBe(0);
		});

		it("leaves a connection that never dropped alone", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
			expect(h.compares()).toBe(0);
		});

		it("compares after a failure the browser never announced", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});
			h.setUnreachable(true);
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
			expect(h.compares()).toBe(1);
		});

		it("keeps a startup-only schedule to its one sync", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(1);

			await dropAndRestore(h);

			expect(h.syncs()).toBe(1);
			expect(h.compares()).toBe(1);
		});

		it("still owes a startup-only schedule the sync it missed offline", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			h.setCompared(false);
			vi.stubGlobal("navigator", { onLine: false });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(0);

			vi.stubGlobal("navigator", { onLine: true });
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);

			expect(h.syncs()).toBe(1);
		});

		it("stops a startup-only schedule retrying once its missed sync landed", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			h.setUnreachable(true);
			// The startup sync fails at 3s; the 30s heartbeat defers behind the cooldown.
			await vi.advanceTimersByTimeAsync(40_000);
			expect(h.syncs()).toBe(1);

			h.fire("online");
			h.setUnreachable(false);
			await vi.advanceTimersByTimeAsync(0);
			expect(h.syncs()).toBe(2);

			await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
			expect(h.syncs()).toBe(2);
		});

		it("ends an error backoff", async () => {
			const h = harness({ autoSyncIntervalMinutes: 1 });
			h.setSyncError("backend down");
			// Failures at 3s, 60s and 120s arm the backoff until 240s.
			await vi.advanceTimersByTimeAsync(121_000);
			expect(h.syncs()).toBe(3);

			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);

			expect(h.syncs()).toBe(4);
		});
	});

	it("retries an unreachable storage without waiting out the interval", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(MINUTE_MS);

		expect(h.syncs()).toBe(2);
	});

	it("retries a shared folder whose storage is unreachable", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setShareUnreachable(true);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(MINUTE_MS);

		expect(h.syncs()).toBe(2);
	});

	it("compares a shared folder that went unreachable when the connection returns", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10, autoSyncEnabled: false });
		h.setShareUnreachable(true);
		h.fire("online");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.compares()).toBe(1);
	});

	it("does not queue a second cycle behind a retry that is still running", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		const release = h.holdSyncs();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);

		h.setUnreachable(false);
		release();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
	});

	it("backs off an unreachable storage like any failing one", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		// Tries at 3s, 60s and 90s; the third failure arms 2 min, then 4 min: 210s, then 450s.
		expect(h.syncs()).toBe(5);
	});

	it("checks the heartbeat often enough for a one-minute interval", () => {
		expect(SCHEDULER_HEARTBEAT_MS).toBeLessThanOrEqual(MINUTE_MS);
	});
});
