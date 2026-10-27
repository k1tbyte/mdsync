import { clamp, type MdsyncSettings } from "@/core/settings";

import { defaultS3Config } from "./backends/s3";
import type { EStorageBackend, StorageAdapterConfig } from "./config";
import { CONCURRENCY_FIELD } from "./field-spec";
import { getDescriptor, isAdapterConfigured, isKnownBackend } from "./registry";

declare module "@/core/settings" {
	interface MdsyncSettings {
		storageConfigs: Record<string, StorageAdapterConfig>;
		activeStorageKind: EStorageBackend;
	}
}

type StorageSettings = Pick<
	MdsyncSettings,
	"storageConfigs" | "activeStorageKind"
>;

export function parseStorageSettings(
	stored: Partial<StorageSettings> | null | undefined,
): StorageSettings {
	const storageConfigs: Record<string, StorageAdapterConfig> = {
		...(stored?.storageConfigs ?? {}),
	};
	// Backfill fields added after initial save from backend defaults.
	for (const [kind, config] of Object.entries(storageConfigs)) {
		if (!isKnownBackend(kind) || !config || typeof config !== "object") {
			delete storageConfigs[kind];
			continue;
		}
		config.concurrency = clamp(
			config.concurrency,
			CONCURRENCY_FIELD,
			getDescriptor(kind).defaults().concurrency,
		);
	}
	if (Object.keys(storageConfigs).length === 0) {
		const fallback = defaultS3Config();
		storageConfigs[fallback.kind] = fallback;
	}
	const requested = stored?.activeStorageKind;
	const activeStorageKind =
		requested && storageConfigs[requested]
			? requested
			: (Object.keys(storageConfigs)[0] as EStorageBackend);
	return { storageConfigs, activeStorageKind };
}

export function activeStorage(settings: StorageSettings): StorageAdapterConfig {
	return (
		settings.storageConfigs[settings.activeStorageKind] ?? defaultS3Config()
	);
}

export function isStorageConfigured(settings: StorageSettings): boolean {
	return isAdapterConfigured(activeStorage(settings));
}
