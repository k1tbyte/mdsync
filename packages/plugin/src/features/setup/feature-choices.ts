import { isRelayConfigured, type MdsyncSettings } from "@/core/settings";

/** The Features step's presets over the automation settings; read from them, never stored. */
export const ESyncMode = {
	Manual: "manual",
	Automatic: "automatic",
	/** Automatic plus real-time sync, over a relay. */
	Instant: "instant",
} as const;
export type ESyncMode = (typeof ESyncMode)[keyof typeof ESyncMode];

/** What Automatic schedules when the interval was left at 0 (one sync after startup). */
export const AUTOMATIC_INTERVAL_MINUTES = 5;

export function syncModeOf(settings: MdsyncSettings): ESyncMode {
	if (settings.realtimeSync && isRelayConfigured(settings)) {
		return ESyncMode.Instant;
	}
	return settings.autoSyncEnabled ? ESyncMode.Automatic : ESyncMode.Manual;
}

/**
 * Real-time sync turns on only with a relay to carry it; without one the relay step turns it on
 * once a relay answers (`useRelay`).
 */
export function syncModePatch(
	settings: MdsyncSettings,
	mode: ESyncMode,
): Partial<MdsyncSettings> {
	if (mode === ESyncMode.Manual) {
		return {
			autoSyncEnabled: false,
			autoPushAfterChange: false,
			realtimeSync: false,
		};
	}
	return {
		autoSyncEnabled: true,
		autoPushAfterChange: true,
		autoSyncIntervalMinutes:
			settings.autoSyncIntervalMinutes || AUTOMATIC_INTERVAL_MINUTES,
		realtimeSync: mode === ESyncMode.Instant && isRelayConfigured(settings),
	};
}
