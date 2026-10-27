import type { MdsyncSettings } from "@/core/settings";
import { isStorageConfigured } from "@/features/storage";

/** Share records are the spaces slice's: read structurally, never imported. */
type GuestSettings = Pick<
	MdsyncSettings,
	"storageConfigs" | "activeStorageKind"
> & {
	spaces: readonly { closed?: true; access: { kind: string } }[];
};

/** No vault storage, only shares joined by invite: those sync, the vault stays on this device. */
export function isGuest(settings: GuestSettings): boolean {
	return (
		!isStorageConfigured(settings) &&
		settings.spaces.some(
			(record) => !record.closed && record.access.kind === "participant",
		)
	);
}

export function canSync(settings: GuestSettings): boolean {
	return isStorageConfigured(settings) || isGuest(settings);
}
