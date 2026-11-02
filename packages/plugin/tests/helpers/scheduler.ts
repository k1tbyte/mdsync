import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/settings";
import type { MdsyncSettings } from "@/core/settings";
import {
	registerScheduler,
	type SchedulerHost,
} from "@/features/sync/automation/scheduler";
import { SlowFiles } from "@/features/sync/automation/slow-files";
import type { SyncController } from "@/features/sync/controller";
import { type Space, VAULT_SPACE } from "@/features/sync/remote/space";

export interface SchedulerOptions {
	/** Over the defaults, with a configured storage so `canSync` holds. */
	settings?: Partial<MdsyncSettings>;
	/** False waits for the metadata cache before the first run. */
	layoutReady?: boolean;
	/** Whether the metadata cache had settled before the scheduler registered. */
	initialized?: boolean;
	spaces?: readonly Space[];
	/** A passphrase entered or saved on this device; asking for one is never allowed here. */
	savedPassphrase?: boolean;
	/** The saved passphrase was rotated on another device: opening the vault with it fails. */
	rotated?: boolean;
	/** A compare that already ran, as the Changes panel does when it shows. */
	compared?: boolean;
}

export interface SchedulerHarness {
	host: SchedulerHost;
	slow: SlowFiles;
	/** Full cycles (`refreshAndAutoSync`). */
	syncs: () => number;
	pushFlags: () => ReadonlyArray<boolean>;
	/** Plain compares: no pull, no push. */
	compares: () => number;
	connectivityChanges: () => number;
	/** Queued pushes (`refreshAndAutoPush`) with the paths each was given; undefined means every change. */
	pushes: () => ReadonlyArray<ReadonlySet<string> | undefined>;
	sharePushes: () => ReadonlyArray<ReadonlySet<string>>;
	saved: () => readonly string[];
	/** A vault event; `oldPath` is the source of a rename. */
	emit: (event: string, path: string, oldPath?: string) => void;
	/** Shows `path` in the active view. */
	open: (path: string | null) => void;
	fire: (event: "online" | "offline") => void;
	goOnline: () => void;
	resolveCache: () => void;
	unload: () => void;
	/** A manual cycle: the controller goes busy, then idle. */
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
}

type VaultListener = (file: { path: string }, oldPath?: string) => void;

/** The scheduler over a stub plugin host and a controller that only counts what it is asked. */
export function schedulerHarness(
	options: SchedulerOptions = {},
): SchedulerHarness {
	let syncs = 0;
	let compares = 0;
	let connectivityChanges = 0;
	const pushFlags: boolean[] = [];
	const pushes: Array<ReadonlySet<string> | undefined> = [];
	const sharePushes: ReadonlySet<string>[] = [];
	const saved: string[] = [];
	const teardown: Array<() => void> = [];
	const resolvedListeners: Array<() => void> = [];
	const workspaceListeners: Array<() => void> = [];
	const vaultListeners = new Map<string, VaultListener>();
	const domListeners = new Map<string, () => void>();
	let active: string | null = null;
	let snapshotError: string | null = null;
	let snapshotOffline = false;
	let shareUnreachable = false;
	let compared = options.compared ?? true;
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
			...options.settings,
		},
		app: {
			workspace: {
				layoutReady: options.layoutReady ?? true,
				getActiveFile: () => (active === null ? null : { path: active }),
				on: (_event: string, listener: () => void) => {
					workspaceListeners.push(listener);
					return {};
				},
			},
			metadataCache: {
				initialized: options.initialized ?? true,
				on: (event: string, listener: () => void) => {
					if (event === "resolved") resolvedListeners.push(listener);
					return {};
				},
				getCache: (path: string) =>
					path === "Sketch.md"
						? { frontmatter: { "excalidraw-plugin": "parsed" } }
						: null,
			},
			vault: {
				on: (event: string, listener: VaultListener) => {
					vaultListeners.set(event, listener);
					return {};
				},
			},
		},
		spaces: { partition: () => options.spaces ?? [VAULT_SPACE] },
		passphrase: {
			unlock: async () => {
				if (options.rotated) throw new Error("rotated elsewhere");
				return options.savedPassphrase ?? true;
			},
		},
		register: (fn: () => void) => teardown.push(fn),
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
			compares++;
		},
		refreshAndAutoPush: async (paths?: ReadonlySet<string>) => {
			pushes.push(paths);
		},
		autoPushShares: async (paths: ReadonlySet<string>) => {
			sharePushes.push(paths);
		},
		connectivityChanged: () => {
			connectivityChanges++;
		},
		noteLocalChange: () => undefined,
		refreshSaved: (path: string) => saved.push(path),
		getSnapshot: current,
		subscribe: (
			listener: (
				snapshot: ReturnType<typeof current> & { busy: boolean },
			) => void,
		) => {
			statusListeners.push(listener);
			return () => undefined;
		},
		slowFiles: new SlowFiles(),
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		slow: controller.slowFiles,
		syncs: () => syncs,
		pushFlags: () => pushFlags,
		compares: () => compares,
		connectivityChanges: () => connectivityChanges,
		pushes: () => pushes,
		sharePushes: () => sharePushes,
		saved: () => saved,
		emit: (event, path, oldPath) => {
			const listener = vaultListeners.get(event);
			if (!listener) throw new Error(`Missing ${event} listener`);
			listener({ path }, oldPath);
		},
		open: (path) => {
			active = path;
			for (const fn of workspaceListeners) fn();
		},
		fire: (event) => domListeners.get(event)?.(),
		goOnline: () => {
			vi.stubGlobal("navigator", { onLine: true });
			domListeners.get("online")?.();
		},
		resolveCache: () => {
			for (const fn of resolvedListeners) fn();
		},
		unload: () => {
			for (const fn of teardown) fn();
		},
		manualSync: () => {
			for (const listener of statusListeners)
				listener({ ...current(), busy: true });
			for (const listener of statusListeners)
				listener({ ...current(), busy: false });
		},
		setSyncError: (error) => {
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
	};
}
