import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/settings";
import {
	registerScheduler,
	type SchedulerHost,
} from "@/features/sync/automation/scheduler";
import { SlowFiles } from "@/features/sync/automation/slow-files";
import type { SyncController } from "@/features/sync/controller";

interface Harness {
	host: SchedulerHost;
	refreshes: () => number;
	/** Plain compares: no pull, no push. */
	compares: () => number;
	resolveCache: () => void;
	unload: () => void;
}

function harness(state: {
	layoutReady: boolean;
	initialized?: boolean;
	autosync?: boolean;
	/** A passphrase entered or saved on this device; asking for one is never allowed here. */
	savedPassphrase?: boolean;
	/** The saved passphrase was rotated on another device: opening the vault with it fails. */
	rotated?: boolean;
	/** A compare that already ran, as the Changes panel does when it shows. */
	compared?: boolean;
}): Harness {
	let refreshes = 0;
	let compares = 0;
	const teardown: Array<() => void> = [];
	const resolvedListeners: Array<() => void> = [];
	const host = {
		settings: {
			...DEFAULT_SETTINGS,
			autoSyncEnabled: state.autosync ?? true,
			autoSyncIntervalMinutes: 10,
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
				layoutReady: state.layoutReady,
				on: () => ({}),
				getActiveFile: () => null,
			},
			metadataCache: {
				initialized: state.initialized,
				on: (name: string, fn: () => void) => {
					if (name === "resolved") resolvedListeners.push(fn);
					return {};
				},
			},
			vault: { on: () => ({}) },
		},
		passphrase: {
			unlock: async () => {
				if (state.rotated) throw new Error("rotated elsewhere");
				return state.savedPassphrase ?? true;
			},
		},
		register: (fn: () => void) => teardown.push(fn),
		registerInterval: () => undefined,
		registerDomEvent: () => undefined,
		registerEvent: () => undefined,
	} as unknown as SchedulerHost;
	const controller = {
		refreshAndAutoSync: async () => {
			refreshes++;
		},
		refresh: async () => {
			compares++;
		},
		getSnapshot: () => ({
			error: null,
			offline: false,
			spaceErrors: [],
			result: state.compared ? {} : null,
		}),
		subscribe: () => () => undefined,
		slowFiles: new SlowFiles(),
	} as unknown as SyncController;
	registerScheduler(host, controller);
	return {
		host,
		refreshes: () => refreshes,
		compares: () => compares,
		resolveCache: () => {
			for (const fn of resolvedListeners) fn();
		},
		unload: () => {
			for (const fn of teardown) fn();
		},
	};
}

describe("startup autosync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("navigator", { onLine: true });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("waits for the metadata cache while it is still filling", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.refreshes()).toBe(0);

		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.refreshes()).toBe(1);

		// The event keeps firing as the vault changes; the first run is the only one.
		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.refreshes()).toBe(1);
	});

	it("runs anyway when the cache never reports itself settled", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.refreshes()).toBe(1);
	});

	it("keeps the short delay for a cache that settled before it registered", async () => {
		const h = harness({ layoutReady: false, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.refreshes()).toBe(1);
	});

	it("keeps the short delay for a plugin enabled by hand", async () => {
		const h = harness({ layoutReady: true, initialized: true });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(h.refreshes()).toBe(1);
	});

	it("does not run after unload", async () => {
		const h = harness({ layoutReady: false, initialized: false });
		h.unload();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.refreshes()).toBe(0);
	});

	it("only compares at startup when autosync is off", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.refreshes()).toBe(0);
		expect(h.compares()).toBe(1);
	});

	it("waits for the metadata cache before that compare too", async () => {
		const h = harness({
			layoutReady: false,
			initialized: false,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(h.compares()).toBe(0);
		h.resolveCache();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.compares()).toBe(1);
	});

	it("never asks for a passphrase on launch to compare", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			savedPassphrase: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("skips the compare when the saved passphrase no longer opens the vault", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			rotated: true,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("leaves a compare that already ran alone", async () => {
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
			compared: true,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});

	it("does not compare offline", async () => {
		vi.stubGlobal("navigator", { onLine: false });
		const h = harness({
			layoutReady: true,
			initialized: true,
			autosync: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.compares()).toBe(0);
	});
});
