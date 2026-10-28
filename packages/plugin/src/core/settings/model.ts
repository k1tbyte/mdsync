import {
	AUTO_PUSH_SETTLE_MAX_SECONDS,
	AUTO_PUSH_SETTLE_MIN_SECONDS,
	AUTO_SYNC_MAX_MINUTES,
	AUTO_SYNC_MIN_MINUTES,
	BULK_DELETE_LIMIT_MAX,
	BULK_DELETE_LIMIT_MIN,
	HISTORY_KEEP_MS,
	LIVE_SEND_MS,
} from "@/core/constants";
import { isCleartextRemote } from "@/core/shared";

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

export type HistoryKeep = keyof typeof HISTORY_KEEP_MS;

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

/** What core parses. A field typed by a feature joins `MdsyncSettings` by module augmentation where that feature parses it. */
export interface CoreSettings {
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
	/** An automatic push publishing more than `bulkDeleteLimit` deletions holds them all for review. */
	confirmBulkDeletes: boolean;
	bulkDeleteLimit: number;
	fileHistoryEnabled: boolean;
	fileHistoryKeep: HistoryKeep;
	historyAutoRefresh: boolean;
	realtimeSync: boolean;
	/** Notes open in the editor edit together across devices, over the relay. */
	liveEditing: boolean;
	/** Live edits go out at most this often (ms), on this device. Never transferred. */
	liveSendMs: number;
	/** Others' text in live notes tinted by author, on this device. */
	showLiveAuthors: boolean;
	showOpenNote: boolean;
	/** Off: every share is paused here and kept out of sight. Never published. */
	useSharedFolders: boolean;
	/** Shares this device holds out of sync; never published, unlike `spaces`. */
	pausedSpaces: string[];
	/** Shares this person adds on other devices arrive paused here. Never published. */
	pauseArrivingShares: boolean;
	/** A change in a shared folder is pushed once the folder is quiet a moment, not with the vault. */
	pushSharesRightAway: boolean;
	/** Only added, moved and deleted files go right away; edits wait for a push. */
	shareEditsWait: boolean;
	/** Shares moved on another device, by id: where the folder still is here. Never published. */
	localRoots: Record<string, string>;
	/** The vault storage (identity) the records were traded with: another vault's never reach this one. */
	spacesVault: string | null;
	/** Self-hosted worker (packages/relay): realtime signals. */
	relayUrl: string;
	/** The worker's RELAY_SECRET; relay room tokens derive from it. */
	relaySecret: string;
	/** Deploys and updates the relay, and made the R2 keys. Device-local, never transferred. */
	cloudflareToken: string;
	cloudflareAccountId: string;
	cachePassphrase: boolean;
	showStatusBar: boolean;
	showRibbonIcon: boolean;
	showFileExplorerIndicators: boolean;
	/** The dot, arrow or warning beside a changed name in the file tree; the name keeps its colour. */
	showChangeMarks: boolean;
	showEditorChangeSigns: boolean;
	showFileSizes: boolean;
	uiLayout: "tree" | "flat";
}

export interface MdsyncSettings extends CoreSettings {}

export const DEFAULT_CORE_SETTINGS: CoreSettings = {
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
	confirmBulkDeletes: true,
	bulkDeleteLimit: 5,
	fileHistoryEnabled: false,
	fileHistoryKeep: "quarter",
	historyAutoRefresh: true,
	realtimeSync: false,
	liveEditing: true,
	liveSendMs: LIVE_SEND_MS.balanced,
	showLiveAuthors: false,
	showOpenNote: true,
	useSharedFolders: true,
	pausedSpaces: [],
	pauseArrivingShares: false,
	pushSharesRightAway: true,
	shareEditsWait: true,
	localRoots: {},
	spacesVault: null,
	relayUrl: "",
	relaySecret: "",
	cloudflareToken: "",
	cloudflareAccountId: "",
	cachePassphrase: true,
	showStatusBar: true,
	showRibbonIcon: true,
	showFileExplorerIndicators: true,
	showChangeMarks: true,
	showEditorChangeSigns: true,
	showFileSizes: true,
	uiLayout: "tree",
};

export type RelayConfig = Pick<CoreSettings, "relayUrl" | "relaySecret">;

/** Both or nothing: the URL alone opens no room and signs nothing. A relay that takes the secret in the clear is none. */
export function isRelayConfigured(relay: RelayConfig): boolean {
	return (
		Boolean(relay.relayUrl && relay.relaySecret) &&
		!isCleartextRemote(relay.relayUrl)
	);
}

/** Dropped settings. Several held secrets - share keys among them - so they are deleted, not kept. */
const RETIRED_KEYS = [
	"realtimeServerUrl",
	"realtimeToken",
	"shareBrokerUrl",
	"shareBrokerAdminSecret",
	"sharedFolders",
	"shareStorageKind",
	"fileHistoryMaxSnapshots",
] as const;

/** Bounds for numeric settings. Clamping here prevents invalid values from files or tokens. */
export const NUMERIC_BOUNDS = {
	maxFileBytes: { min: 1, max: 2 * 1024 * 1024 * 1024 },
	autoSyncIntervalMinutes: {
		min: AUTO_SYNC_MIN_MINUTES,
		max: AUTO_SYNC_MAX_MINUTES,
	},
	autoPushSettleSeconds: {
		min: AUTO_PUSH_SETTLE_MIN_SECONDS,
		max: AUTO_PUSH_SETTLE_MAX_SECONDS,
	},
	bulkDeleteLimit: {
		min: BULK_DELETE_LIMIT_MIN,
		max: BULK_DELETE_LIMIT_MAX,
	},
} as const satisfies Partial<Record<keyof CoreSettings, Bounds>>;

export interface Bounds {
	min: number;
	max: number;
}

/** Returns fallback if below minimum; caps if above maximum. */
export function clamp(
	value: unknown,
	bounds: Bounds,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < bounds.min) return fallback;
	return Math.min(bounds.max, Math.round(value));
}

/** Non-empty strings only: a root decides which files a space owns. */
function stringValues(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1] !== "",
		),
	);
}

/** Keeps unknown stored keys: the slices parse theirs over this. */
export function mergeCoreSettings(
	stored: Partial<CoreSettings> | null | undefined,
): CoreSettings {
	const merged: CoreSettings = {
		...DEFAULT_CORE_SETTINGS,
		...(stored ?? {}),
		// A preset only: the dropdown shows nothing else.
		liveSendMs: Object.values<unknown>(LIVE_SEND_MS).includes(
			stored?.liveSendMs,
		)
			? (stored?.liveSendMs as number)
			: DEFAULT_CORE_SETTINGS.liveSendMs,
		fileHistoryKeep: Object.keys(HISTORY_KEEP_MS).includes(
			stored?.fileHistoryKeep as string,
		)
			? (stored?.fileHistoryKeep as HistoryKeep)
			: DEFAULT_CORE_SETTINGS.fileHistoryKeep,
		settingsSync: {
			...DEFAULT_SETTINGS_SYNC,
			...((stored?.settingsSync as
				| Partial<SettingsSyncCategories>
				| undefined) ?? {}),
		},
		pausedSpaces: Array.isArray(stored?.pausedSpaces)
			? stored.pausedSpaces.filter((id) => typeof id === "string")
			: [],
		localRoots: stringValues(stored?.localRoots),
		spacesVault:
			typeof stored?.spacesVault === "string" ? stored.spacesVault : null,
	};
	for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
		const field = key as keyof typeof NUMERIC_BOUNDS;
		merged[field] = clamp(merged[field], bounds, DEFAULT_CORE_SETTINGS[field]);
	}
	for (const key of RETIRED_KEYS) Reflect.deleteProperty(merged, key);
	return merged;
}
