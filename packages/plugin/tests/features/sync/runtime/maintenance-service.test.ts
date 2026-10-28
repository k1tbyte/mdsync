import { FakeStorage } from "@tests/helpers/fake-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMOTE_HISTORY_LOG_KEY } from "@/features/sync/constants";
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
	storage = new FakeStorage(),
) {
	const logWarn = vi.fn(() => Promise.resolve());
	const logInfo = vi.fn(() => Promise.resolve());
	const remember = vi.fn();
	const queued: Promise<unknown>[] = [];
	const maintenance = new MaintenanceService({
		openSession: async (space) =>
			({
				space,
				storage,
				key: {},
				history: history ?? undefined,
			}) as unknown as EngineDependencies,
		enqueue: (task) => task(),
		enqueueQuiet: (task) => {
			const run = Promise.resolve().then(task);
			queued.push(run.catch(() => undefined));
			return run;
		},
		logInfo,
		logWarn,
		remember,
	});
	const settled = () => Promise.all(queued).then(() => undefined);
	return { maintenance, logWarn, logInfo, remember, settled };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	collect.mockReset();
	collect.mockResolvedValue({
		written: 0,
		retired: 0,
		swept: 0,
		activity: null,
	});
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

	it("remembers the vault's activity, never a share's", async () => {
		const activity = { 100: [2, 1] as [number, number] };
		collect.mockResolvedValue({ written: 0, retired: 0, swept: 0, activity });
		const storage = new FakeStorage();
		const { maintenance, remember, settled } = service(undefined, storage);
		maintenance.afterPush({ id: "share", root: "Shared" });
		maintenance.afterPush(VAULT_SPACE);
		await settled();
		expect(remember.mock.calls).toEqual([
			[storage.identity(), activity, Date.now()],
		]);
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

	it("clears 1.x history even with history off", async () => {
		const storage = new FakeStorage();
		await storage.put(REMOTE_HISTORY_LOG_KEY, new Uint8Array([1]));
		const { maintenance, logInfo, settled } = service(null, storage);
		maintenance.afterPush(VAULT_SPACE);
		await settled();
		expect(await storage.exists(REMOTE_HISTORY_LOG_KEY)).toBe(false);
		expect(logInfo).toHaveBeenCalledWith(
			"push",
			"Old-format file history removed (1 object(s)).",
		);
		expect(collect).not.toHaveBeenCalled();
	});

	it("scans for 1.x history once a session, again after a failed scan", async () => {
		const storage = new FakeStorage();
		const list = vi
			.spyOn(storage, "list")
			.mockRejectedValueOnce(new Error("offline"));
		const { maintenance, settled } = service(null, storage);
		for (let run = 0; run < 3; run++) {
			maintenance.afterPush(VAULT_SPACE);
			await settled();
			vi.setSystemTime(Date.now() + 10 * 60_000);
		}
		expect(list).toHaveBeenCalledTimes(2);
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
