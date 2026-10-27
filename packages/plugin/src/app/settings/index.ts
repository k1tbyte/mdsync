import { type MdsyncSettings, mergeCoreSettings } from "@/core/settings";
import { parseStoredLinks } from "@/features/links";
import { parseSpaceRecords } from "@/features/spaces";
import { parseStorageSettings } from "@/features/storage";

/** Each slice parses the fields it declares over the core ones. */
export function mergeSettings(
	stored: Partial<MdsyncSettings> | null | undefined,
): MdsyncSettings {
	return {
		...mergeCoreSettings(stored),
		...parseStorageSettings(stored),
		spaces: parseSpaceRecords(stored?.spaces),
		links: parseStoredLinks(stored?.links),
	};
}

export const DEFAULT_SETTINGS: MdsyncSettings = mergeSettings(null);
