import type { Plugin, TAbstractFile } from "obsidian";

import { canSync, type ObsyncSettings } from "@/settings/model";
import type { SyncController } from "./controller";
import { VAULT_SPACE } from "./space";

const AUTO_PULL_STARTUP_DELAY_MS = 3_000;

/** Cap on waiting for the metadata cache, so a vault that never reports it settled still syncs. */
const AUTO_PULL_INDEX_WAIT_MS = 60_000;

const AUTO_SYNC_BUSY_COOLDOWN_MS = 30_000;

/** Long enough that moving a folder goes out as one push. */
const SHARE_PUSH_QUIET_MS = 2_000;

/** How often the auto-sync timer wakes up to check what is due. */
export const SCHEDULER_HEARTBEAT_MS = 30_000;

const SCHEDULER_BACKOFF_THRESHOLD = 3;

const SCHEDULER_BACKOFF_BASE_MS = 2 * 60_000;

const SCHEDULER_BACKOFF_MAX_MS = 60 * 60_000;

export interface SchedulerHost extends Plugin {
	settings: ObsyncSettings;
}

export function registerScheduler(
	host: SchedulerHost,
	controller: SyncController,
): void {
	let lastRun = 0;
	let consecutiveFailures = 0;
	let backoffUntil = 0;

	const tick = async (): Promise<void> => {
		if (!navigator.onLine) return;
		if (!canSync(host.settings)) return;
		const now = Date.now();
		if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) return;
		if (now < backoffUntil) return;
		lastRun = now;
		await controller.refreshAndAutoSync(host.settings.autoPushAfterSync);
		// The flows report failures via error state, not throws. Read it for backoff.
		if (!controller.getSnapshot().error) {
			consecutiveFailures = 0;
			backoffUntil = 0;
			return;
		}
		consecutiveFailures++;
		if (consecutiveFailures >= SCHEDULER_BACKOFF_THRESHOLD) {
			const exp = consecutiveFailures - SCHEDULER_BACKOFF_THRESHOLD;
			const delay = Math.min(
				SCHEDULER_BACKOFF_BASE_MS * 2 ** exp,
				SCHEDULER_BACKOFF_MAX_MS,
			);
			backoffUntil = Date.now() + delay;
		}
	};

	// Any finished cycle - the user's manual pull or push, a realtime-signal
	// pull, the queued settle push - counts as a fresh sync, so a due tick
	// never duplicates work that just ran.
	let wasBusy = false;
	host.register(
		controller.subscribe((snapshot) => {
			if (snapshot.busy) wasBusy = true;
			else if (wasBusy) {
				wasBusy = false;
				lastRun = Date.now();
				// A clean finish - the user's manual sync included - proves the
				// backend works again, so leave the error backoff behind.
				if (!snapshot.error) {
					consecutiveFailures = 0;
					backoffUntil = 0;
				}
			}
		}),
	);

	// Interval 0 with the toggle on is a deliberate mode: sync once after
	// startup, then stay quiet until the next reload.
	if (host.settings.autoSyncEnabled) {
		scheduleFirstRun(host, () => void tick());
	}

	// Read the interval on every wake-up so setting changes apply without restart.
	let minutesInEffect = host.settings.autoSyncIntervalMinutes;
	let dueAt = dueAfter(minutesInEffect);
	host.registerInterval(
		window.setInterval(() => {
			const minutes = host.settings.autoSyncIntervalMinutes;
			if (minutes !== minutesInEffect) {
				minutesInEffect = minutes;
				dueAt = dueAfter(minutes);
			}
			const now = Date.now();
			if (!host.settings.autoSyncEnabled || dueAt <= 0 || now < dueAt) return;
			if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) {
				// A cycle just ran by hand: retry once the cooldown passes, not a
				// whole interval later.
				dueAt = lastRun + AUTO_SYNC_BUSY_COOLDOWN_MS;
				return;
			}
			dueAt = dueAfter(minutes);
			void tick();
		}, SCHEDULER_HEARTBEAT_MS),
	);

	const queueVaultPush = quietQueue(
		host,
		() => host.settings.autoPushSettleSeconds * 1000,
		(paths) => void runQueuedPush(host, controller, paths),
	);
	// One per share: typing in one must not hold back another's push.
	const shareQueues = new Map<string, (path: string) => void>();
	const queueSharePush = (space: string, path: string): void => {
		let queue = shareQueues.get(space);
		if (!queue) {
			queue = quietQueue(
				host,
				() => SHARE_PUSH_QUIET_MS,
				(paths) => {
					if (host.settings.pushSharesRightAway && canSync(host.settings)) {
						void controller.autoPushShares(paths);
					}
				},
			);
			shareQueues.set(space, queue);
		}
		queue(path);
	};
	const onVaultEvent = (file: TAbstractFile, oldPath?: string): void => {
		for (const path of oldPath ? [file.path, oldPath] : [file.path]) {
			const { id } = controller.spaceFor(path);
			const shared = id !== VAULT_SPACE.id;
			if (shared && host.settings.pushSharesRightAway) queueSharePush(id, path);
			else if (host.settings.autoPushAfterChange) queueVaultPush(path);
		}
	};
	host.registerEvent(host.app.vault.on("modify", onVaultEvent));
	host.registerEvent(host.app.vault.on("create", onVaultEvent));
	host.registerEvent(host.app.vault.on("delete", onVaultEvent));
	host.registerEvent(host.app.vault.on("rename", onVaultEvent));
}

/**
 * The first scan reads Obsidian's metadata cache. Starting before that cache
 * resolves costs three times as much, because the scan competes with Obsidian's
 * own indexing for the main thread. A cache that has already settled waits out
 * the old delay instead: `resolved` would not fire again there until something
 * in the vault changed.
 */
function scheduleFirstRun(host: SchedulerHost, run: () => void): void {
	// `initialized` is not in the typings; without it only `layoutReady` tells a
	// settled cache from one still filling, and a small vault that resolved
	// before this ran would wait out the cap.
	const cache = host.app.metadataCache as { initialized?: boolean };
	if (host.app.workspace.layoutReady || cache.initialized === true) {
		const timer = window.setTimeout(run, AUTO_PULL_STARTUP_DELAY_MS);
		host.register(() => window.clearTimeout(timer));
		return;
	}
	let done = false;
	let timer = 0;
	const fire = (): void => {
		if (done) return;
		done = true;
		window.clearTimeout(timer);
		run();
	};
	timer = window.setTimeout(fire, AUTO_PULL_INDEX_WAIT_MS);
	host.register(() => window.clearTimeout(timer));
	host.registerEvent(host.app.metadataCache.on("resolved", fire));
}

/** Paths gathered until `quietMs()` pass without a new one, then handed to `run` together. */
function quietQueue(
	host: SchedulerHost,
	quietMs: () => number,
	run: (paths: Set<string>) => void,
): (path: string) => void {
	const pending = new Set<string>();
	let timer: number | null = null;
	host.register(() => {
		if (timer !== null) window.clearTimeout(timer);
	});
	return (path) => {
		pending.add(path);
		if (timer !== null) window.clearTimeout(timer);
		// Read per event so a changed quiet period applies to the queue in flight.
		timer = window.setTimeout(() => {
			timer = null;
			const paths = new Set(pending);
			pending.clear();
			run(paths);
		}, quietMs());
	};
}

function dueAfter(minutes: number): number {
	return minutes > 0 ? Date.now() + minutes * 60_000 : 0;
}

async function runQueuedPush(
	host: SchedulerHost,
	controller: SyncController,
	trackedPaths: ReadonlySet<string>,
): Promise<void> {
	if (!canSync(host.settings)) return;
	if (!host.settings.autoPushAfterChange) return;
	await controller.refresh();
	await controller.autoPushFromSnapshot(
		host.settings.autoPushChangedFilesOnly ? trackedPaths : undefined,
	);
}
