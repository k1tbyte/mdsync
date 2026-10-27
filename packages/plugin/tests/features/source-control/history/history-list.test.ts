import { describe, expect, it, vi } from "vitest";
import { HistoryList } from "@/features/source-control/history/history-list";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe("HistoryList", () => {
	it("loads once at a time and redraws when it lands", async () => {
		const settled = vi.fn();
		const list = new HistoryList<string[]>(settled);
		const first = deferred<string[]>();
		const fetch = vi.fn(() => first.promise);

		list.load(fetch);
		list.load(fetch);
		first.resolve(["a"]);
		await flush();

		expect(fetch).toHaveBeenCalledOnce();
		expect(list.value).toEqual(["a"]);
		expect(settled).toHaveBeenCalledOnce();
	});

	it("drops a load started before clear", async () => {
		const settled = vi.fn();
		const list = new HistoryList<string[]>(settled);
		const stale = deferred<string[]>();
		const fresh = deferred<string[]>();

		list.load(() => stale.promise);
		list.clear();
		list.load(() => fresh.promise);
		stale.resolve(["old"]);
		await flush();
		expect(list.value).toBeNull();
		expect(settled).not.toHaveBeenCalled();

		fresh.reject(new Error("boom"));
		await flush();
		expect(list.error).toBe("boom");
		expect(settled).toHaveBeenCalledOnce();
	});
});
