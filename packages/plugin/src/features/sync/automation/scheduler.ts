import type { Plugin, TAbstractFile } from "obsidian";
import type { MdsyncSettings } from "@/core/settings";
import type { SyncController, SyncStatusSnapshot } from "../controller";
import { type Space, spaceOf, VAULT_SPACE } from "../remote/space";
import { canSync } from "../settings";
import { isSlowFile, type QueueEdit } from "./slow-files";

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
	settings: MdsyncSettings;
	/** The records' partition: known from launch, before any refresh partitions. */
	spaces: { partition(): readonly Space[] };
}

export function registerScheduler(
	host: SchedulerHost,
	controller: SyncController,
): void {
	let lastRun = 0;
	let consecutiveFailures = 0;
	let backoffUntil = 0;
	// Interval 0 means one sync after startup: until one lands cleanly, a reconnect still owes it.
	let startupOwed = true;
	const mayAutoSync = (): boolean =>
		host.settings.autoSyncEnabled &&
		(host.settings.autoSyncIntervalMinutes > 0 || startupOwed);

	// A retry slower than the heartbeat must not queue a second cycle behind itself.
	let ticking = false;
	const tick = async (): Promise<void> => {
		if (ticking) return;
		if (!navigator.onLine) return;
		if (!canSync(host.settings)) return;
		const now = Date.now();
		if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) return;
		if (now < backoffUntil) return;
		lastRun = now;
		ticking = true;
		try {
			await controller.refreshAndAutoSync(host.settings.autoPushAfterSync);
		} finally {
			ticking = false;
		}
		// The flows report failures via error state, not throws. Read it for backoff.
		const snapshot = controller.getSnapshot();
		if (!snapshot.error && !cannotReach(snapshot)) {
			consecutiveFailures = 0;
			backoffUntil = 0;
			startupOwed = false;
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

	// Any finished cycle (manual, realtime-signal, settle push) counts as a fresh sync, so a due tick never
	// duplicates it.
	let wasBusy = false;
	host.register(
		controller.subscribe((snapshot) => {
			if (snapshot.busy) wasBusy = true;
			else if (wasBusy) {
				wasBusy = false;
				lastRun = Date.now();
				// A clean finish, manual included, proves the backend works again.
				if (!snapshot.error && !cannotReach(snapshot)) {
					consecutiveFailures = 0;
					backoffUntil = 0;
				}
			}
		}),
	);

	// Interval 0 with the toggle on is deliberate: sync once after startup, then stay quiet until reload.
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
			if (!mayAutoSync()) return;
			// Online but a storage unreachable: no `online` event will come, so retry without waiting out the interval.
			const unreachable =
				navigator.onLine && cannotReach(controller.getSnapshot());
			if (!unreachable && (dueAt <= 0 || now < dueAt)) return;
			if (now - lastRun < AUTO_SYNC_BUSY_COOLDOWN_MS) {
				// A cycle just ran by hand: retry after the cooldown, not a whole interval later.
				dueAt = lastRun + AUTO_SYNC_BUSY_COOLDOWN_MS;
				return;
			}
			dueAt = dueAfter(minutes);
			void tick();
		}, SCHEDULER_HEARTBEAT_MS),
	);

	// Offline or backing off, a push would only fail and log again: its paths wait.
	const resumers: Array<() => void> = [];
	const onOnline = resumers.push.bind(resumers);
	let droppedOffline = false;
	host.registerDomEvent(window, "offline", () => {
		droppedOffline = true;
		controller.connectivityChanged();
	});
	host.registerDomEvent(window, "online", () => {
		const snapshot = controller.getSnapshot();
		const recover =
			droppedOffline ||
			cannotReach(snapshot) ||
			Boolean(snapshot.error) ||
			!snapshot.result;
		droppedOffline = false;
		controller.connectivityChanged();
		consecutiveFailures = 0;
		backoffUntil = 0;
		for (const resume of resumers) resume();
		if (!recover || !canSync(host.settings)) return;
		if (mayAutoSync()) {
			lastRun = 0;
			void tick();
		} else {
			void controller.refresh();
		}
	});
	const backingOff = (): boolean => Date.now() < backoffUntil;
	const slow = controller.slowFiles;
	host.register(() => slow.clear());
	const slowQuietMs = (): number => host.settings.slowFileSettleSeconds * 1000;
	const settle = (paths: ReadonlySet<string>) => (): void =>
		slow.settled(paths, slowQuietMs(), queueEdit);
	const queueVaultPush = quietQueue(
		host,
		() => host.settings.autoPushSettleSeconds * 1000,
		backingOff,
		onOnline,
		(paths) =>
			void runQueuedPush(host, controller, paths).finally(settle(paths)),
	);
	// One per share: typing in one must not hold back another's push.
	const shareQueues = new Map<string, (path: string) => void>();
	const queueSharePush = (space: string, path: string): void => {
		let queue = shareQueues.get(space);
		if (!queue) {
			queue = quietQueue(
				host,
				() => SHARE_PUSH_QUIET_MS,
				backingOff,
				onOnline,
				(paths) => {
					const push =
						host.settings.pushSharesRightAway && canSync(host.settings)
							? controller.autoPushShares(paths)
							: Promise.resolve();
					void push.finally(settle(paths));
				},
			);
			shareQueues.set(space, queue);
		}
		queue(path);
	};
	/** Where an event of `path` queues; null when nothing there pushes on its own. */
	const queueOf = (
		path: string,
		edit: boolean,
	): ((path: string) => void) | null => {
		const { id, paused, readOnly } = spaceOf(host.spaces.partition(), path);
		// Nothing there pushes: queued, it would only refresh.
		if (paused || readOnly) return null;
		const rightAway =
			id !== VAULT_SPACE.id && host.settings.pushSharesRightAway;
		// A waiting edit keeps its gutter marks until someone pushes it.
		if (rightAway && !(edit && host.settings.shareEditsWait)) {
			return (queued) => queueSharePush(id, queued);
		}
		return !rightAway && host.settings.autoPushAfterChange
			? queueVaultPush
			: null;
	};
	const queueEdit: QueueEdit = (path) => {
		const queue = queueOf(path, true);
		queue?.(path);
		return queue !== null;
	};
	const activePath = (): string | null =>
		host.app.workspace.getActiveFile()?.path ?? null;
	const onVaultEvent =
		(edit: boolean) =>
		(file: TAbstractFile, oldPath?: string): void => {
			controller.noteLocalChange();
			if (edit) controller.refreshSaved(file.path);
			for (const path of oldPath ? [file.path, oldPath] : [file.path]) {
				if (!edit) slow.forget(path);
				const queue = queueOf(path, edit);
				if (!queue) continue;
				// Held only where its edit queues: nothing else would ever release it to an automatic push.
				if (
					edit &&
					path === activePath() &&
					isSlowFile(host.app, path, host.settings.slowFileSuffixes)
				) {
					slow.saved(path, slowQuietMs(), queueEdit);
				} else {
					queue(path);
				}
			}
		};
	const leave = (): void => slow.left(activePath(), queueEdit);
	host.registerEvent(host.app.workspace.on("active-leaf-change", leave));
	host.registerEvent(host.app.workspace.on("file-open", leave));
	host.registerEvent(host.app.vault.on("modify", onVaultEvent(true)));
	host.registerEvent(host.app.vault.on("create", onVaultEvent(false)));
	host.registerEvent(host.app.vault.on("delete", onVaultEvent(false)));
	host.registerEvent(host.app.vault.on("rename", onVaultEvent(false)));
}

/**
 * Starting before the metadata cache resolves costs 3x, as the scan competes with Obsidian's indexing. An
 * already-settled cache never re-fires `resolved`, so it uses the fixed delay.
 */
function scheduleFirstRun(host: SchedulerHost, run: () => void): void {
	// `initialized` is not in the typings; without it a small vault that resolved before this ran would wait
	// out the cap.
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

/**
 * Paths gathered until `quietMs()` pass without a new one, then handed to `run` together. Offline they
 * wait for the `online` event; backing off, they ask again each quiet period, as a clean sync ends it early.
 */
function quietQueue(
	host: SchedulerHost,
	quietMs: () => number,
	backingOff: () => boolean,
	onOnline: (resume: () => void) => void,
	run: (paths: Set<string>) => void,
): (path: string) => void {
	const pending = new Set<string>();
	let timer: number | null = null;
	host.register(() => {
		if (timer !== null) window.clearTimeout(timer);
	});
	onOnline(() => {
		if (pending.size > 0 && timer === null) arm();
	});
	const fire = (): void => {
		timer = null;
		if (!navigator.onLine) return;
		if (backingOff()) {
			arm();
			return;
		}
		const paths = new Set(pending);
		pending.clear();
		run(paths);
	};
	// Read per arm so a changed quiet period applies to the queue in flight.
	const arm = (): void => {
		timer = window.setTimeout(fire, quietMs());
	};
	return (path) => {
		pending.add(path);
		if (timer !== null) window.clearTimeout(timer);
		arm();
	};
}

/** The vault's storage or a share's: no connection to it is worth retrying on its own. */
function cannotReach(snapshot: SyncStatusSnapshot): boolean {
	return (
		snapshot.offline || snapshot.spaceErrors.some(({ offline }) => offline)
	);
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
	await controller.refreshAndAutoPush(
		host.settings.autoPushChangedFilesOnly ? trackedPaths : undefined,
	);
}
