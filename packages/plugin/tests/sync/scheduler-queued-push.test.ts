import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/settings/model";
import type { SyncController } from "@/sync/controller";
import { registerScheduler, type SchedulerHost } from "@/sync/scheduler";
import { VAULT_SPACE } from "@/sync/space";

const SETTLE_MS = DEFAULT_SETTINGS.autoPushSettleSeconds * 1000;

interface Harness {
	host: SchedulerHost;
	emit: (event: string, path: string, oldPath?: string) => void;
	refreshes: () => number;
	pushes: () => ReadonlyArray<ReadonlySet<string> | undefined>;
	sharePushes: () => ReadonlyArray<ReadonlySet<string>>;
}

const SHARES: Record<string, { id: string; root: string }> = {
	Team: { id: "team", root: "Team" },
	Other: { id: "other", root: "Other" },
};

function harness(options: {
	enabled: boolean;
	queuedOnly: boolean;
	settleSeconds?: number;
}): Harness {
	let refreshes = 0;
	const pushes: Array<ReadonlySet<string> | undefined> = [];
	const listeners = new Map<
		string,
		(file: { path: string }, oldPath?: string) => void
	>();
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
			workspace: { layoutReady: true },
			metadataCache: {
				initialized: true,
				on: () => ({}),
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
		register: () => undefined,
		registerInterval: () => undefined,
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const sharePushes: ReadonlySet<string>[] = [];
	const controller = {
		refresh: async () => {
			refreshes++;
		},
		autoPushFromSnapshot: async (paths?: ReadonlySet<string>) => {
			pushes.push(paths);
		},
		autoPushShares: async (paths: ReadonlySet<string>) => {
			sharePushes.push(paths);
		},
		spaceFor: (path: string) => SHARES[path.split("/")[0] ?? ""] ?? VAULT_SPACE,
		subscribe: () => () => undefined,
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

	it("gives each shared folder its own quiet period", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "Team/a.md");
		await vi.advanceTimersByTimeAsync(1_500);
		h.emit("modify", "Other/b.md");
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

	it("drops queued work if the setting is disabled before it runs", async () => {
		const h = harness({ enabled: true, queuedOnly: true });
		h.emit("modify", "a.md");
		h.host.settings.autoPushAfterChange = false;
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		expect(h.refreshes()).toBe(0);
		expect(h.pushes()).toHaveLength(0);
	});
});
