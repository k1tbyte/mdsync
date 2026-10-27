import type { DataAdapter } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogService } from "@/core/logs/log-service";
import { ESyncLogOperation } from "@/core/logs/store";

function service() {
	const write = vi.fn(async () => undefined);
	const adapter = {
		exists: async () => true,
		mkdir: async () => undefined,
		write,
		rename: async () => undefined,
		remove: async () => undefined,
		read: async () => "[]",
	} as unknown as DataAdapter;
	return { logs: new LogService(adapter, ".obsidian"), write };
}

describe("LogService", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("shows an entry at once and writes a burst of them once", async () => {
		const { logs, write } = service();
		await logs.info(ESyncLogOperation.Push, "one");
		await logs.info(ESyncLogOperation.Push, "two");

		expect(logs.getEntries()).toHaveLength(2);
		expect(write).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("flushes pending entries on dispose", async () => {
		const { logs, write } = service();
		await logs.warn(ESyncLogOperation.Pull, "late");
		logs.dispose();
		await vi.advanceTimersByTimeAsync(0);

		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("writes a line logged after dispose at once, arming no timer", async () => {
		const { logs, write } = service();
		logs.dispose();
		await logs.info(ESyncLogOperation.Pull, "cancelled");

		expect(write).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("writes the emptied log on clear and drops the pending write", async () => {
		const { logs, write } = service();
		await logs.error(ESyncLogOperation.Push, "x");
		await logs.clear();
		await vi.advanceTimersByTimeAsync(2000);

		expect(logs.getEntries()).toEqual([]);
		expect(write).toHaveBeenCalledTimes(1);
	});
});
