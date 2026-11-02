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
	// Push after change uploads on its own, so it is not Manual.
	return settings.autoSyncEnabled || settings.autoPushAfterChange
		? ESyncMode.Automatic
		: ESyncMode.Manual;
}

/** Instant without a relay is a wish over Automatic's settings; turning them Manual elsewhere drops it. */
function standingPick(
	picked: ESyncMode | null,
	settings: MdsyncSettings,
): ESyncMode | null {
	return picked === ESyncMode.Instant &&
		syncModeOf(settings) === ESyncMode.Manual
		? ESyncMode.Manual
		: picked;
}

export function shownSyncMode(
	picked: ESyncMode | null,
	settings: MdsyncSettings,
): ESyncMode {
	return standingPick(picked, settings) === ESyncMode.Instant &&
		!isRelayConfigured(settings)
		? ESyncMode.Instant
		: syncModeOf(settings);
}

/** The relay step turns real-time sync on for a relay unless Manual or Automatic was picked on purpose. */
export function enablesRealtime(
	picked: ESyncMode | null,
	settings: MdsyncSettings,
): boolean {
	const standing = standingPick(picked, settings);
	return standing === null || standing === ESyncMode.Instant;
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
