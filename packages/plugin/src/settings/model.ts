import {
	AUTO_PUSH_SETTLE_MAX_SECONDS,
	AUTO_PUSH_SETTLE_MIN_SECONDS,
	AUTO_SYNC_MAX_MINUTES,
	AUTO_SYNC_MIN_MINUTES,
	FILE_HISTORY_MAX_SNAPSHOTS,
	FILE_HISTORY_MIN_SNAPSHOTS,
} from "@/constants";
import {
	defaultS3Config,
	type EStorageBackend,
	getDescriptor,
	isAdapterConfigured,
	isKnownBackend,
	type StorageAdapterConfig,
} from "@/storage";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

const DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS = 50;

export interface SettingsSyncCategories {
	coreSettings: boolean;
	hotkeys: boolean;
	pluginList: boolean;
	pluginConfigs: boolean;
	snippets: boolean;
	themes: boolean;
}

export const DEFAULT_SETTINGS_SYNC: SettingsSyncCategories = {
	coreSettings: false,
	hotkeys: false,
	pluginList: false,
	pluginConfigs: false,
	snippets: false,
	themes: false,
};

export interface ObsyncSettings {
	/** Per-backend saved configs. */
	storageConfigs: Record<string, StorageAdapterConfig>;
	activeStorageKind: EStorageBackend;
	settingsSync: SettingsSyncCategories;
	ignorePatterns: string;
	/** Skip symlinks and directory links pointing outside the vault. */
	ignoreSymlinks: boolean;
	maxFileBytes: number;
	/** Master switch for scheduled sync; the interval alone does not enable it. */
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	/** Push local changes after a scheduled pull; off means a pull-only device. */
	autoPushAfterSync: boolean;
	autoPushAfterChange: boolean;
	autoPushSettleSeconds: number;
	autoPushChangedFilesOnly: boolean;
	fileHistoryEnabled: boolean;
	fileHistoryMaxSnapshots: number;
	historyAutoRefresh: boolean;
	realtimeSync: boolean;
	/** Self-hosted worker (packages/relay): realtime signals. */
	relayUrl: string;
	/** The worker's RELAY_SECRET; relay room tokens derive from it. */
	relaySecret: string;
	cachePassphrase: boolean;
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	showEditorChangeSigns: boolean;
	showFileSizes: boolean;
	uiLayout: "tree" | "flat";
}

const DEFAULT_STORAGE = defaultS3Config();

export const DEFAULT_SETTINGS: ObsyncSettings = {
	storageConfigs: { [DEFAULT_STORAGE.kind]: DEFAULT_STORAGE },
	activeStorageKind: DEFAULT_STORAGE.kind,
	settingsSync: DEFAULT_SETTINGS_SYNC,
	ignorePatterns: "",
	ignoreSymlinks: true,
	maxFileBytes: DEFAULT_MAX_FILE_BYTES,
	autoSyncEnabled: false,
	autoSyncIntervalMinutes: 0,
	autoPushAfterSync: true,
	autoPushAfterChange: false,
	autoPushSettleSeconds: 10,
	autoPushChangedFilesOnly: false,
	fileHistoryEnabled: false,
	fileHistoryMaxSnapshots: DEFAULT_FILE_HISTORY_MAX_SNAPSHOTS,
	historyAutoRefresh: true,
	realtimeSync: false,
	relayUrl: "",
	relaySecret: "",
	cachePassphrase: true,
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	showEditorChangeSigns: true,
	showFileSizes: true,
	uiLayout: "tree",
};

export function activeStorage(settings: ObsyncSettings): StorageAdapterConfig {
	return (
		settings.storageConfigs[settings.activeStorageKind] ?? defaultS3Config()
	);
}

export function isStorageConfigured(settings: ObsyncSettings): boolean {
	return isAdapterConfigured(activeStorage(settings));
}

export type RelayConfig = Pick<ObsyncSettings, "relayUrl" | "relaySecret">;

/** Both or nothing: the URL alone opens no room and signs nothing. */
export function isRelayConfigured(relay: RelayConfig): boolean {
	return Boolean(relay.relayUrl && relay.relaySecret);
}

/** Dropped settings. Several held secrets - share keys among them - so they are deleted, not kept. */
const RETIRED_KEYS = [
	"realtimeServerUrl",
	"realtimeToken",
	"shareBrokerUrl",
	"shareBrokerAdminSecret",
	"sharedFolders",
	"shareStorageKind",
] as const;

/** Bounds for numeric settings. Clamping here prevents invalid values from files or tokens. */
const NUMERIC_BOUNDS = {
	maxFileBytes: { min: 1, max: 2 * 1024 * 1024 * 1024 },
	autoSyncIntervalMinutes: {
		min: AUTO_SYNC_MIN_MINUTES,
		max: AUTO_SYNC_MAX_MINUTES,
	},
	autoPushSettleSeconds: {
		min: AUTO_PUSH_SETTLE_MIN_SECONDS,
		max: AUTO_PUSH_SETTLE_MAX_SECONDS,
	},
	fileHistoryMaxSnapshots: {
		min: FILE_HISTORY_MIN_SNAPSHOTS,
		max: FILE_HISTORY_MAX_SNAPSHOTS,
	},
} as const satisfies Partial<Record<keyof ObsyncSettings, Bounds>>;

const CONCURRENCY_BOUNDS: Bounds = { min: 1, max: 32 };

interface Bounds {
	min: number;
	max: number;
}

/** Returns fallback if below minimum; caps if above maximum. */
function clamp(value: unknown, bounds: Bounds, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < bounds.min) return fallback;
	return Math.min(bounds.max, Math.round(value));
}

type StoredSettings = Partial<ObsyncSettings>;

export function mergeSettings(
	stored: StoredSettings | null | undefined,
): ObsyncSettings {
	const storageConfigs: Record<string, StorageAdapterConfig> = {
		...(stored?.storageConfigs ?? {}),
	};
	// Backfill fields added after initial save from backend defaults.
	for (const [kind, config] of Object.entries(storageConfigs)) {
		if (!isKnownBackend(kind)) {
			delete storageConfigs[kind];
			continue;
		}
		config.concurrency = clamp(
			config.concurrency,
			CONCURRENCY_BOUNDS,
			getDescriptor(kind).defaults().concurrency,
		);
	}
	if (Object.keys(storageConfigs).length === 0) {
		storageConfigs[DEFAULT_STORAGE.kind] = DEFAULT_STORAGE;
	}
	const requested = stored?.activeStorageKind;
	const activeStorageKind =
		requested && storageConfigs[requested]
			? requested
			: (Object.keys(storageConfigs)[0] as EStorageBackend);

	const merged: ObsyncSettings = {
		...DEFAULT_SETTINGS,
		...(stored ?? {}),
		storageConfigs,
		activeStorageKind,
		settingsSync: {
			...DEFAULT_SETTINGS_SYNC,
			...((stored?.settingsSync as
				| Partial<SettingsSyncCategories>
				| undefined) ?? {}),
		},
	};
	for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
		const field = key as keyof typeof NUMERIC_BOUNDS;
		merged[field] = clamp(merged[field], bounds, DEFAULT_SETTINGS[field]);
	}
	for (const key of RETIRED_KEYS) Reflect.deleteProperty(merged, key);
	return merged;
}
