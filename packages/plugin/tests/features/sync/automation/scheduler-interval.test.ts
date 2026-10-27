import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/core/settings/model";
import {
	registerScheduler,
	SCHEDULER_HEARTBEAT_MS,
	type SchedulerHost,
} from "@/features/sync/automation/scheduler";
import type { SyncController } from "@/features/sync/controller";
import { VAULT_SPACE } from "@/features/sync/remote/space";

const MINUTE_MS = 60_000;

interface Harness {
	host: SchedulerHost;
	syncs: () => number;
	pushFlags: () => ReadonlyArray<boolean>;
	manualSync: () => void;
	setSyncError: (error: string | null) => void;
	/** The storage is unreachable while the browser still reports a connection. */
	setUnreachable: (unreachable: boolean) => void;
	/** Only a shared folder's storage is unreachable; the vault's is fine. */
	setShareUnreachable: (unreachable: boolean) => void;
	/** Whether a comparison has landed yet. */
	setCompared: (compared: boolean) => void;
	/** Syncs stay in flight until the returned release runs. */
	holdSyncs: () => () => void;
	fire: (event: "online" | "offline") => void;
	refreshes: () => number;
	connectivityChanges: () => number;
	edit: (path: string) => void;
	pushes: () => number;
}

function harness(settings: {
	autoSyncIntervalMinutes: number;
	autoSyncEnabled?: boolean;
	autoPushAfterSync?: boolean;
}): Harness {
	let syncs = 0;
	let pushes = 0;
	let refreshes = 0;
	let connectivityChanges = 0;
	const vaultListeners = new Map<string, (file: { path: string }) => void>();
	const domListeners = new Map<string, () => void>();
	const pushFlags: Array<boolean> = [];
	let snapshotError: string | null = null;
	let snapshotOffline = false;
	let shareUnreachable = false;
	let compared = true;
	let gate: Promise<void> | null = null;
	const current = () => ({
		error: snapshotError,
		offline: snapshotOffline,
		spaceErrors: shareUnreachable
			? [{ root: "Team", message: "No connection", offline: true }]
			: [],
		result: compared ? {} : null,
	});
	const statusListeners: Array<
		(snapshot: ReturnType<typeof current> & { busy: boolean }) => void
	> = [];
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoSyncEnabled: settings.autoSyncEnabled ?? true,
			autoSyncIntervalMinutes: settings.autoSyncIntervalMinutes,
			autoPushAfterSync: settings.autoPushAfterSync ?? true,
			autoPushAfterChange: true,
			storageConfigs: {
				[DEFAULT_SETTINGS.activeStorageKind]: {
					...DEFAULT_SETTINGS.storageConfigs[
						DEFAULT_SETTINGS.activeStorageKind
					],
					bucket: "b",
					accessKeyId: "k",
					secretAccessKey: "s",
				},
			},
		},
		app: {
			workspace: { layoutReady: true },
			metadataCache: {
				initialized: true,
				on: () => ({}),
			},
			vault: {
				on: (event: string, listener: (file: { path: string }) => void) => {
					vaultListeners.set(event, listener);
					return {};
				},
			},
		},
		spaces: { partition: () => [VAULT_SPACE] },
		register: () => undefined,
		registerInterval: () => undefined,
		registerDomEvent: (_target: unknown, event: string, fn: () => void) => {
			domListeners.set(event, fn);
		},
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refreshAndAutoSync: async (push: boolean) => {
			syncs++;
			pushFlags.push(push);
			await gate;
		},
		refresh: async () => {
			refreshes++;
		},
		connectivityChanged: () => {
			connectivityChanges++;
		},
		refreshAndAutoPush: async () => {
			pushes++;
		},
		noteLocalChange: () => undefined,
		refreshSaved: () => undefined,
		getSnapshot: current,
		subscribe: (
			listener: (
				snapshot: ReturnType<typeof current> & { busy: boolean },
			) => void,
		) => {
			statusListeners.push(listener);
			return () => undefined;
		},
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		syncs: () => syncs,
		pushFlags: () => pushFlags,
		manualSync: () => {
			for (const listener of statusListeners)
				listener({ ...current(), busy: true });
			for (const listener of statusListeners)
				listener({ ...current(), busy: false });
		},
		setSyncError: (error: string | null) => {
			snapshotError = error;
		},
		setUnreachable: (unreachable) => {
			snapshotOffline = unreachable;
		},
		setShareUnreachable: (unreachable) => {
			shareUnreachable = unreachable;
		},
		setCompared: (value) => {
			compared = value;
		},
		holdSyncs: () => {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			return () => {
				gate = null;
				release();
			};
		},
		fire: (event) => domListeners.get(event)?.(),
		refreshes: () => refreshes,
		connectivityChanges: () => connectivityChanges,
		edit: (path) => vaultListeners.get("modify")?.({ path }),
		pushes: () => pushes,
	};
}

describe("auto-sync intervals", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("runs a full sync on its interval", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("does nothing before the interval is due", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 30_001);
		expect(h.syncs()).toBe(1);
	});

	it("never fires while autosync is disabled", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10, autoSyncEnabled: false });
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(0);
	});

	it("syncs only once after startup when the interval is zero", async () => {
		const h = harness({ autoSyncIntervalMinutes: 0 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
	});

	it("passes the push preference into the sync cycle", async () => {
		const h = harness({
			autoSyncIntervalMinutes: 10,
			autoPushAfterSync: false,
		});
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.pushFlags()).toEqual([false]);
		const full = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(full.pushFlags()).toEqual([true]);
	});

	it("applies a shortened interval without a restart", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
		h.host.settings.autoSyncIntervalMinutes = 1;
		await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
		expect(h.syncs()).toBe(2);
	});

	it("defers a due cycle that follows a manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10 });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);
		// The user finishes a manual sync shortly before the tick is due.
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS - 15_000 - 3_000);
		h.manualSync();
		// The due tick is suppressed and retries after the cooldown, not a
		// whole interval later.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(2);
	});

	it("recovers from error backoff after a successful manual sync", async () => {
		const h = harness({ autoSyncIntervalMinutes: 1 });
		h.setSyncError("backend down");
		// Failures at 3s, 60s and 120s arm the backoff until 240s: the 180s tick is suppressed, the 240s
		// one fails again and extends it to 480s.
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.advanceTimersByTimeAsync(57_000);
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.syncs()).toBe(4);
		// The user fixes the backend and syncs by hand.
		h.setSyncError(null);
		await vi.advanceTimersByTimeAsync(35_000);
		h.manualSync();
		// The due tick defers to the manual cycle, then runs with the backoff
		// cleared instead of waiting out the remaining 3 minutes.
		await vi.advanceTimersByTimeAsync(25_000);
		expect(h.syncs()).toBe(4);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(h.syncs()).toBe(5);
	});

	it("releases a push held by the backoff once a clean sync ends it", async () => {
		const h = harness({ autoSyncIntervalMinutes: 1 });
		const settle = h.host.settings.autoPushSettleSeconds * 1000;
		h.setSyncError("backend down");
		// Failures at 3s, 60s and 120s arm the backoff until 240s.
		await vi.advanceTimersByTimeAsync(120_000);
		h.edit("a.md");
		await vi.advanceTimersByTimeAsync(settle);
		expect(h.pushes()).toBe(0);

		h.setSyncError(null);
		h.manualSync();
		await vi.advanceTimersByTimeAsync(settle);
		expect(h.pushes()).toBe(1);
	});

	describe("when the connection returns", () => {
		const dropAndRestore = async (h: Harness): Promise<void> => {
			vi.stubGlobal("navigator", { onLine: false });
			h.fire("offline");
			await vi.advanceTimersByTimeAsync(5_000);
			vi.stubGlobal("navigator", { onLine: true });
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
		};

		it("syncs at once instead of waiting out the interval", async () => {
			const h = harness({ autoSyncIntervalMinutes: 60 });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(1);

			await dropAndRestore(h);

			expect(h.syncs()).toBe(2);
			expect(h.connectivityChanges()).toBe(2);
		});

		it("only compares when autosync is off", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});

			await dropAndRestore(h);

			expect(h.refreshes()).toBe(1);
			expect(h.syncs()).toBe(0);
		});

		it("leaves a connection that never dropped alone", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
			expect(h.refreshes()).toBe(0);
		});

		it("compares after a failure the browser never announced", async () => {
			const h = harness({
				autoSyncIntervalMinutes: 10,
				autoSyncEnabled: false,
			});
			h.setUnreachable(true);
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);
			expect(h.refreshes()).toBe(1);
		});

		it("keeps a startup-only schedule to its one sync", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(1);

			await dropAndRestore(h);

			expect(h.syncs()).toBe(1);
			expect(h.refreshes()).toBe(1);
		});

		it("still owes a startup-only schedule the sync it missed offline", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			h.setCompared(false);
			vi.stubGlobal("navigator", { onLine: false });
			await vi.advanceTimersByTimeAsync(3_000);
			expect(h.syncs()).toBe(0);

			vi.stubGlobal("navigator", { onLine: true });
			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);

			expect(h.syncs()).toBe(1);
		});

		it("stops a startup-only schedule retrying once its missed sync landed", async () => {
			const h = harness({ autoSyncIntervalMinutes: 0 });
			h.setUnreachable(true);
			// The startup sync fails at 3s; the 30s heartbeat defers behind the cooldown.
			await vi.advanceTimersByTimeAsync(40_000);
			expect(h.syncs()).toBe(1);

			h.fire("online");
			h.setUnreachable(false);
			await vi.advanceTimersByTimeAsync(0);
			expect(h.syncs()).toBe(2);

			await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
			expect(h.syncs()).toBe(2);
		});

		it("ends an error backoff", async () => {
			const h = harness({ autoSyncIntervalMinutes: 1 });
			h.setSyncError("backend down");
			// Failures at 3s, 60s and 120s arm the backoff until 240s.
			await vi.advanceTimersByTimeAsync(121_000);
			expect(h.syncs()).toBe(3);

			h.fire("online");
			await vi.advanceTimersByTimeAsync(0);

			expect(h.syncs()).toBe(4);
		});
	});

	it("retries an unreachable storage without waiting out the interval", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(MINUTE_MS);

		expect(h.syncs()).toBe(2);
	});

	it("retries a shared folder whose storage is unreachable", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setShareUnreachable(true);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(MINUTE_MS);

		expect(h.syncs()).toBe(2);
	});

	it("compares a shared folder that went unreachable when the connection returns", async () => {
		const h = harness({ autoSyncIntervalMinutes: 10, autoSyncEnabled: false });
		h.setShareUnreachable(true);
		h.fire("online");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.refreshes()).toBe(1);
	});

	it("does not queue a second cycle behind a retry that is still running", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		const release = h.holdSyncs();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.syncs()).toBe(1);

		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);

		h.setUnreachable(false);
		release();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
		expect(h.syncs()).toBe(1);
	});

	it("backs off an unreachable storage like any failing one", async () => {
		const h = harness({ autoSyncIntervalMinutes: 60 });
		h.setUnreachable(true);
		await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
		// Tries at 3s, 60s and 90s; the third failure arms 2 min, then 4 min: 210s, then 450s.
		expect(h.syncs()).toBe(5);
	});

	it("checks the heartbeat often enough for a one-minute interval", () => {
		expect(SCHEDULER_HEARTBEAT_MS).toBeLessThanOrEqual(MINUTE_MS);
	});
});
