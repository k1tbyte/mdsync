import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/settings";

import {
	registerScheduler,
	type SchedulerHost,
} from "@/features/sync/automation/scheduler";
import {
	SLOW_FILE_CAP_MS,
	SlowFiles,
} from "@/features/sync/automation/slow-files";
import type { SyncController } from "@/features/sync/controller";
import { type Space, VAULT_SPACE } from "@/features/sync/remote/space";

const SETTLE_MS = DEFAULT_SETTINGS.autoPushSettleSeconds * 1000;
const SLOW_MS = DEFAULT_SETTINGS.slowFileSettleSeconds * 1000;
const DRAWING = "d.excalidraw.md";

interface Harness {
	host: SchedulerHost;
	emit: (event: string, path: string, oldPath?: string) => void;
	refreshes: () => number;
	pushes: () => ReadonlyArray<ReadonlySet<string> | undefined>;
	sharePushes: () => ReadonlyArray<ReadonlySet<string>>;
	goOnline: () => void;
	saved: () => readonly string[];
	/** Shows `path` in the active view. */
	open: (path: string | null) => void;
	slow: SlowFiles;
}

const SHARES: Record<string, Space> = {
	Team: { id: "team", root: "Team" },
	Other: { id: "other", root: "Other" },
	Resting: { id: "resting", root: "Resting", paused: true },
	Theirs: { id: "theirs", root: "Theirs", readOnly: true },
};

function harness(options: {
	enabled: boolean;
	queuedOnly: boolean;
	settleSeconds?: number;
}): Harness {
	let refreshes = 0;
	const pushes: Array<ReadonlySet<string> | undefined> = [];
	const onlineListeners: Array<() => void> = [];
	const listeners = new Map<
		string,
		(file: { path: string }, oldPath?: string) => void
	>();
	const workspaceListeners: Array<() => void> = [];
	let active: string | null = null;
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoSyncIntervalMinutes: 0,
			autoPushAfterChange: options.enabled,
			autoPushSettleSeconds:
				options.settleSeconds ?? DEFAULT_SETTINGS.autoPushSettleSeconds,
			autoPushChangedFilesOnly: options.queuedOnly,
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
			workspace: {
				layoutReady: true,
				getActiveFile: () => (active === null ? null : { path: active }),
				on: (_event: string, listener: () => void) => {
					workspaceListeners.push(listener);
					return {};
				},
			},
			metadataCache: {
				initialized: true,
				on: () => ({}),
				getCache: (path: string) =>
					path === "Sketch.md"
						? { frontmatter: { "excalidraw-plugin": "parsed" } }
						: null,
			},
			vault: {
				on: (
					event: string,
					listener: (file: { path: string }, oldPath?: string) => void,
				) => {
					listeners.set(event, listener);
					return {};
				},
			},
		},
		spaces: { partition: () => [VAULT_SPACE, ...Object.values(SHARES)] },
		register: () => undefined,
		registerInterval: () => undefined,
		registerDomEvent: (_target: unknown, event: string, fn: () => void) => {
			if (event === "online") onlineListeners.push(fn);
		},
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const sharePushes: ReadonlySet<string>[] = [];
	const saved: string[] = [];
	const controller = {
		noteLocalChange: vi.fn(),
		refreshSaved: (path: string) => saved.push(path),
		refreshAndAutoPush: async (paths?: ReadonlySet<string>) => {
			refreshes++;
			pushes.push(paths);
		},
		autoPushShares: async (paths: ReadonlySet<string>) => {
			sharePushes.push(paths);
		},
		slowFiles: new SlowFiles(),
		subscribe: () => () => undefined,
		connectivityChanged: () => undefined,
		getSnapshot: () => ({
			offline: false,
			error: null,
			spaceErrors: [],
			result: {},
		}),
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		sharePushes: () => sharePushes,
		emit: (event, path, oldPath) => {
			const listener = listeners.get(event);
			if (!listener) throw new Error(`Missing ${event} listener`);
			listener({ path }, oldPath);
		},
		refreshes: () => refreshes,
		pushes: () => pushes,
		saved: () => saved,
		goOnline: () => {
			vi.stubGlobal("navigator", { onLine: true });
			for (const fn of onlineListeners) fn();
		},
		open: (path) => {
			active = path;
			for (const fn of workspaceListeners) fn();
		},
		slow: controller.slowFiles,
	};
}

describe("queued push after changes settle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("refreshes a saved file's status on modify only, whatever the push settings", () => {
		const h = harness({ enabled: false, queuedOnly: true });
		h.emit("modify", "a.md");
		h.emit("modify", "Team/b.md");
		h.emit("create", "c.md");
		h.emit("delete", "d.md");
		h.emit("rename", "e.md", "old.md");
		expect(h.saved()).toEqual(["a.md", "Team/b.md"]);
	});

	it("keeps the changes while offline and pushes them once back", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		vi.stubGlobal("navigator", { onLine: false });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS * 3);
		expect(h.refreshes()).toBe(0);

		// Only the heartbeat interval is left: no quiet timer polls while offline.
		expect(vi.getTimerCount()).toBe(1);

		h.goOnline();
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.pushes()).toEqual([new Set(["a.md"])]);
	});

	it("does no work while disabled", async () => {
		const h = harness({ enabled: false, queuedOnly: true });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
		expect(h.refreshes()).toBe(0);
		expect(h.pushes()).toHaveLength(0);
	});

	it("combines rapid changes and waits out the quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS / 2);
		h.emit("create", "b.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
		expect(h.refreshes()).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(h.refreshes()).toBe(1);
		expect(h.pushes()).toHaveLength(1);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["a.md", "b.md"]);
	});

	it("queues both sides of a rename", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("rename", "new.md", "old.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["new.md", "old.md"]);
	});

	it("can push every pending local change", async () => {
		const h = harness({ enabled: true, queuedOnly: false });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.pushes()).toEqual([undefined]);
	});

	it("honours a custom quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true, settleSeconds: 5 });
		h.emit("modify", "a.md");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(h.refreshes()).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.refreshes()).toBe(1);
	});

	it("pushes a shared folder's changes on their own, two quiet seconds later", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.host.settings.shareEditsWait = false;
		h.emit("rename", "Team/new.md", "old.md");
		h.emit("modify", "Team/b.md");
		await vi.advanceTimersByTimeAsync(1_999);
		expect(h.sharePushes()).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(h.sharePushes().map((paths) => [...paths])).toEqual([
			["Team/new.md", "Team/b.md"],
		]);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["old.md"]);
	});

	it("leaves a shared folder's edits for a push, its added, moved and deleted files not", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "Team/a.md");
		h.emit("create", "Team/b.md");
		h.emit("rename", "Team/c.md", "Team/old.md");
		h.emit("delete", "Team/d.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);

		expect(h.sharePushes().map((paths) => [...paths])).toEqual([
			["Team/b.md", "Team/c.md", "Team/old.md", "Team/d.md"],
		]);
		expect(h.pushes()).toHaveLength(0);
	});

	it("gives each shared folder its own quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("create", "Team/a.md");
		await vi.advanceTimersByTimeAsync(1_500);
		h.emit("create", "Other/b.md");
		await vi.advanceTimersByTimeAsync(500);
		expect(h.sharePushes().map((paths) => [...paths])).toEqual([["Team/a.md"]]);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(h.sharePushes()).toHaveLength(2);
	});

	it("leaves a shared folder to the vault's queue when it is not pushed right away", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.host.settings.pushSharesRightAway = false;
		h.emit("modify", "Team/b.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.sharePushes()).toHaveLength(0);
		expect([...(h.pushes()[0] ?? [])]).toEqual(["Team/b.md"]);
	});

	it("queues nothing from a paused or read-only shared folder", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("create", "Resting/a.md");
		h.emit("create", "Theirs/b.md");
		h.host.settings.pushSharesRightAway = false;
		h.emit("modify", "Resting/a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.sharePushes()).toHaveLength(0);
		expect(h.pushes()).toHaveLength(0);
	});

	it("drops queued work if the setting is disabled before it runs", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "a.md");
		h.host.settings.autoPushAfterChange = false;
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.refreshes()).toBe(0);
		expect(h.pushes()).toHaveLength(0);
	});
});

describe("slow files", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const pushed = (h: Harness): string[][] =>
		h.pushes().map((paths) => [...(paths ?? [])]);

	/** Saves `path` every 5 s for `ms`, as Excalidraw does while someone draws. */
	async function drawFor(h: Harness, path: string, ms: number): Promise<void> {
		for (let at = 0; at < ms; at += 5_000) {
			h.emit("modify", path);
			await vi.advanceTimersByTimeAsync(5_000);
		}
	}

	it("keeps a drawing's saves from holding back the vault's queue", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", "a.md");
		await drawFor(h, DRAWING, 30_000);
		expect(pushed(h)).toEqual([["a.md"]]);
		expect(h.slow.holds(DRAWING)).toBe(true);
	});

	it("pushes a drawing after its own quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", DRAWING);
		await vi.advanceTimersByTimeAsync(SLOW_MS + SETTLE_MS - 1);
		expect(h.pushes()).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(pushed(h)).toEqual([[DRAWING]]);
		expect(h.slow.holds(DRAWING)).toBe(false);
	});

	it("pushes a drawing once its view is left", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", DRAWING);
		h.open("a.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(pushed(h)).toEqual([[DRAWING]]);
	});

	it("pushes nonstop drawing every 10 minutes, then holds it again", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		await drawFor(h, DRAWING, SLOW_FILE_CAP_MS + SETTLE_MS);
		expect(pushed(h)).toEqual([[DRAWING]]);
		expect(h.slow.holds(DRAWING)).toBe(true);
	});

	it("takes a drawing named as a plain note", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open("Sketch.md");
		h.emit("modify", "Sketch.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.pushes()).toHaveLength(0);
		expect(h.slow.holds("Sketch.md")).toBe(true);
	});

	it("queues a slow file as usual when it is not open or not listed", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open("a.md");
		h.emit("modify", DRAWING);
		h.host.settings.slowFileSuffixes = ".canvas";
		h.open("b.excalidraw.md");
		h.emit("modify", "b.excalidraw.md");
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(pushed(h)).toEqual([[DRAWING, "b.excalidraw.md"]]);
	});

	it("lets a rename or deletion of a held file go with its own event", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", DRAWING);
		h.emit("rename", "e.excalidraw.md", DRAWING);
		expect(h.slow.holds(DRAWING)).toBe(false);
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(pushed(h)).toEqual([["e.excalidraw.md", DRAWING]]);
	});

	it("holds nothing where an edit would not queue, so a scheduled push still takes it", () => {
		const h = harness({ enabled: false, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", DRAWING);
		expect(h.slow.holds(DRAWING)).toBe(false);
	});

	it("leaves a new shared drawing to its share's push while its edits wait", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open("Team/new.excalidraw.md");
		h.emit("create", "Team/new.excalidraw.md");
		h.emit("modify", "Team/new.excalidraw.md");
		expect(h.slow.holds("Team/new.excalidraw.md")).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(h.sharePushes().map((paths) => [...paths])).toEqual([
			["Team/new.excalidraw.md"],
		]);
	});

	it("drops a held file whose queue was turned off before it was due", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.open(DRAWING);
		h.emit("modify", DRAWING);
		h.host.settings.autoPushAfterChange = false;
		await vi.advanceTimersByTimeAsync(SLOW_MS);
		expect(h.slow.holds(DRAWING)).toBe(false);
		h.host.settings.autoPushAfterChange = true;
		h.emit("modify", DRAWING);
		expect(h.slow.holds(DRAWING)).toBe(true);
	});
});
