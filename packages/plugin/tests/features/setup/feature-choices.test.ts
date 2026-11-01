import { describe, expect, it } from "vitest";
import { mergeSettings } from "@/app/settings";
import type { MdsyncSettings } from "@/core/settings/model";
import {
	AUTOMATIC_INTERVAL_MINUTES,
	ESyncMode,
	syncModeOf,
	syncModePatch,
} from "@/features/setup/feature-choices";

const RELAY = { relayUrl: "https://relay.example", relaySecret: "secret" };

function apply(
	settings: MdsyncSettings,
	patch: Partial<MdsyncSettings>,
): MdsyncSettings {
	return { ...settings, ...patch };
}

describe("sync mode", () => {
	it("reads Manual from fresh settings", () => {
		expect(syncModeOf(mergeSettings({}))).toBe(ESyncMode.Manual);
	});

	it("round-trips every mode with a relay", () => {
		const base = mergeSettings(RELAY);
		for (const mode of Object.values(ESyncMode)) {
			expect(syncModeOf(apply(base, syncModePatch(base, mode)))).toBe(mode);
		}
	});

	it("keeps real-time sync off without a relay, so Instant reads as Automatic until one answers", () => {
		const base = mergeSettings({});
		const patch = syncModePatch(base, ESyncMode.Instant);
		expect(patch.realtimeSync).toBe(false);
		expect(syncModeOf(apply(base, patch))).toBe(ESyncMode.Automatic);
	});

	it("gives Automatic a schedule when the interval was left at startup only, and keeps one already set", () => {
		const fresh = mergeSettings({});
		expect(
			syncModePatch(fresh, ESyncMode.Automatic).autoSyncIntervalMinutes,
		).toBe(AUTOMATIC_INTERVAL_MINUTES);
		const set = mergeSettings({ autoSyncIntervalMinutes: 30 });
		expect(
			syncModePatch(set, ESyncMode.Automatic).autoSyncIntervalMinutes,
		).toBe(30);
	});

	it("turns every automatic path off for Manual", () => {
		const auto = mergeSettings({
			...RELAY,
			autoSyncEnabled: true,
			autoPushAfterChange: true,
			realtimeSync: true,
		});
		expect(syncModePatch(auto, ESyncMode.Manual)).toEqual({
			autoSyncEnabled: false,
			autoPushAfterChange: false,
			realtimeSync: false,
		});
	});
});
