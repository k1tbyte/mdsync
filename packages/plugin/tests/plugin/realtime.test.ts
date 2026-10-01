import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HubListener } from "@/hub/connection";
import type { LiveHost } from "@/plugin/live";
import { createRealtime } from "@/plugin/realtime";
import { VAULT_SPACE } from "@/sync/space";

const state = vi.hoisted(() => ({ listener: {} as HubListener }));

vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	debounce: (fn: () => void, delay: number) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const call = () => {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				fn();
			}, delay);
		};
		return Object.assign(call, {
			cancel: () => {
				if (timer !== null) clearTimeout(timer);
				timer = null;
			},
		});
	},
}));
vi.mock("@/hub", () => ({
	HubConnection: class {
		listen(listener: HubListener) {
			state.listener = listener;
			return () => {};
		}
		dispose() {}
	},
}));
vi.mock("@/presence", () => ({
	People: class {
		refresh() {}
		dispose() {}
	},
	watchHere: () => ({ refresh() {}, stop() {} }),
}));
vi.mock("@/plugin/space-access", () => ({ createSpaceAccess: () => ({}) }));
vi.mock("@/plugin/live", () => ({
	createLive: () => ({
		sessions: { refresh: async () => {} },
		notes: () => ({}),
		dispose: async () => {},
	}),
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function realtime() {
	const pull = vi.fn(async () => {});
	const host = {
		controller: {
			currentDevice: () => ({ id: "device" }),
			refreshAndAutoPull: pull,
		},
		settings: () => ({}),
		spaces: { partition: () => [] },
		app: {},
	} as unknown as LiveHost;
	return { pull, realtime: createRealtime(host) };
}

describe("cold relay signal batches", () => {
	it("keeps every signalled space without restarting the debounce", async () => {
		const { pull, realtime: live } = realtime();
		state.listener.onSignal?.("a");
		await vi.advanceTimersByTimeAsync(1_000);
		state.listener.onSignal?.("b");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(pull).toHaveBeenCalledExactlyOnceWith(new Set(["a", "b"]));
		live.dispose();
	});

	it("keeps the bug-fix revocation callback as a full refresh", async () => {
		const { pull, realtime: live } = realtime();
		state.listener.onSignal?.("a");
		state.listener.onRevoked?.();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(pull).toHaveBeenCalledExactlyOnceWith(
			new Set(["a", VAULT_SPACE.id]),
		);
		live.dispose();
	});

	it("cancels queued pulls on unload", async () => {
		const { pull, realtime: live } = realtime();
		state.listener.onSignal?.("a");
		live.dispose();
		await vi.runAllTimersAsync();
		expect(pull).not.toHaveBeenCalled();
	});
});
