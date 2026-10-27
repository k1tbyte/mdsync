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

export const FILE_HISTORY_MIN_SNAPSHOTS = 1;

export const FILE_HISTORY_MAX_SNAPSHOTS = 1000;

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
