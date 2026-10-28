export const PLUGIN_ID = "mdsync";

/** The vault storage's head: sync publishes it, storage probes it to tell an empty remote from a vault. */
export const REMOTE_MANIFEST_KEY = "manifest.json.enc";

export const IGNORE_FILE_NAME = "syncignore.md";

export const DEFAULT_CONCURRENCY = 4;

export const AUTO_SYNC_MIN_MINUTES = 0;

export const AUTO_SYNC_MAX_MINUTES = 24 * 60;

export const AUTO_PUSH_SETTLE_MIN_SECONDS = 3;

export const AUTO_PUSH_SETTLE_MAX_SECONDS = 60;

export const BULK_DELETE_LIMIT_MIN = 0;

export const BULK_DELETE_LIMIT_MAX = 1000;

const DAY_MS = 24 * 60 * 60_000;

/** **Keep history for**: past it only activity counts remain; `null` keeps every version tier forever. */
export const HISTORY_KEEP_MS = {
	week: 7 * DAY_MS,
	month: 30 * DAY_MS,
	quarter: 91 * DAY_MS,
	year: 365 * DAY_MS,
	forever: null,
} as const;

/** How **Keep history for** names each choice; the Deleted tab says it too. */
export const HISTORY_KEEP_TEXT = {
	week: "1 week",
	month: "1 month",
	quarter: "3 months",
	year: "1 year",
	forever: "Forever",
} as const satisfies Record<keyof typeof HISTORY_KEEP_MS, string>;

export const SOURCE_CONTROL_VIEW_TYPE = "mdsync-source-control";

export const DIFF_VIEW_TYPE = "mdsync-diff";

export const STORAGE_CHANGED_REASON = "Storage backend changed.";

/** How long live edits wait after a send, by speed: each send is a row the relay writes. */
export const LIVE_SEND_MS = {
	instant: 100,
	balanced: 250,
	economical: 1000,
} as const;

/** Relative times are in minutes: their text is redrawn this often while nothing else redraws it. */
export const RELATIVE_TIME_REFRESH_MS = 60_000;
