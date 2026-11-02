import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScopeRefresh } from "@/app/scope-refresh";
import { mergeSettings } from "@/app/settings";
import type { MdsyncSettings } from "@/core/settings/model";
import { defaultS3Config } from "@/features/storage/backends/s3";
import type { SyncController } from "@/features/sync";

function setup(
	snapshot: { result: boolean; lastCompareAt: number | null; busy: boolean },
	settings: MdsyncSettings,
) {
	const controller = {
		getSnapshot: () => snapshot,
		invalidate: vi.fn(),
		refresh: vi.fn(async () => {}),
	};
	const scope = createScopeRefresh(
		() => controller as unknown as SyncController,
		() => settings,
	);
	return { controller, scope };
}

const COMPARED = { result: true, lastCompareAt: 1, busy: false };
const CONFIGURED = mergeSettings({
	storageConfigs: {
		s3: {
			...defaultS3Config(),
			bucket: "notes",
			accessKeyId: "AKIA",
			secretAccessKey: "S".repeat(40),
		},
	},
});

describe("createScopeRefresh", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("drops the comparison now and compares once the changes settle", () => {
		const { controller, scope } = setup(COMPARED, CONFIGURED);
		scope.schedule("a");
		scope.schedule("b");
		expect(controller.invalidate).toHaveBeenCalledTimes(2);
		expect(controller.refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(800);
		expect(controller.refresh).toHaveBeenCalledOnce();
	});

	it("does nothing before the first comparison has started", () => {
		const { controller, scope } = setup(
			{ result: false, lastCompareAt: null, busy: false },
			CONFIGURED,
		);
		scope.schedule();
		expect(controller.invalidate).not.toHaveBeenCalled();
	});

	it("does not compare when sync is not possible", () => {
		const { controller, scope } = setup(COMPARED, mergeSettings(null));
		scope.schedule();
		vi.advanceTimersByTime(800);
		expect(controller.invalidate).toHaveBeenCalledOnce();
		expect(controller.refresh).not.toHaveBeenCalled();
	});

	it("cancel stops a pending compare", () => {
		const { controller, scope } = setup(COMPARED, CONFIGURED);
		scope.schedule();
		scope.cancel();
		vi.advanceTimersByTime(800);
		expect(controller.refresh).not.toHaveBeenCalled();
	});
});
