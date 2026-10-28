import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDependencies } from "@/features/sync/engine";
import { collectHistoryGarbage } from "@/features/sync/history/gc";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import { MaintenanceService } from "@/features/sync/runtime/maintenance-service";

vi.mock("@/features/sync/history/gc", () => ({
	collectHistoryGarbage: vi.fn(),
}));

const collect = vi.mocked(collectHistoryGarbage);

/** `null`: history off. */
function service(
	history: { horizon: number | null } | null = { horizon: null },
) {
	const logWarn = vi.fn(() => Promise.resolve());
	const logInfo = vi.fn(() => Promise.resolve());
	const queued: Promise<unknown>[] = [];
	const maintenance = new MaintenanceService({
		openSession: async (space) =>
			({
				space,
				storage: {},
				key: {},
				history: history ?? undefined,
			}) as EngineDependencies,
		enqueue: (task) => task(),
		enqueueQuiet: (task) => {
			const run = Promise.resolve().then(task);
			queued.push(run.catch(() => undefined));
			return run;
		},
		logInfo,
		logWarn,
	});
	const settled = () => Promise.all(queued).then(() => undefined);
	return { maintenance, logWarn, logInfo, settled };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	collect.mockReset();
	collect.mockResolvedValue({ written: 0, retired: 0, swept: 0 });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("MaintenanceService.afterPush", () => {
	it("cleans history at most every 10 minutes per space", async () => {
		const { maintenance, settled } = service();
		maintenance.afterPush(VAULT_SPACE);
		maintenance.afterPush(VAULT_SPACE);
		vi.setSystemTime(Date.now() + 10 * 60_000);
		maintenance.afterPush(VAULT_SPACE);
		await settled();
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it("skips a session with history off and runs nothing once disposed", async () => {
		const off = service(null);
		off.maintenance.afterPush(VAULT_SPACE);
		await off.settled();

		const disposed = service();
		disposed.maintenance.afterPush(VAULT_SPACE);
		disposed.maintenance.dispose();
		await disposed.settled();
		expect(collect).not.toHaveBeenCalled();
	});

	it("logs a failure instead of throwing it at the push", async () => {
		collect.mockRejectedValue(new Error("listing failed"));
		const { maintenance, logWarn, settled } = service();
		maintenance.afterPush(VAULT_SPACE);
		await settled();
		await Promise.resolve();
		expect(logWarn).toHaveBeenCalledWith(
			"push",
			"History cleanup failed: listing failed",
		);
	});
});
