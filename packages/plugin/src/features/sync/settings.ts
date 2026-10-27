import type { MdsyncSettings } from "@/core/settings";
import { isStorageConfigured } from "@/features/storage";

/** No vault storage, only shares joined by invite: those sync, the vault stays on this device. */
export function isGuest(settings: MdsyncSettings): boolean {
	return (
		!isStorageConfigured(settings) &&
		settings.spaces.some(
			(record) => !record.closed && record.access.kind === "participant",
		)
	);
}

export function canSync(settings: MdsyncSettings): boolean {
	return isStorageConfigured(settings) || isGuest(settings);
}
