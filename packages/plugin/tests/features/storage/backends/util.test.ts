import { afterEach, describe, expect, it, vi } from "vitest";
import { toArrayBuffer } from "@/core/utils/bytes";
import {
	assertOk,
	isRetryableError,
	isRetryableStatus,
	StorageHttpError,
	StorageTimeoutError,
	transferBytes,
	withDeadline,
	withRetry,
	withTimeout,
} from "@/features/storage/backends/util";

describe("storage error semantics", () => {
	it("treats only 'come back later' statuses as retryable", () => {
		for (const status of [408, 425, 429, 500, 502, 503]) {
			expect(isRetryableStatus(status)).toBe(true);
		}
		// A 404 is an answer, and a 403 will not improve with patience.
		for (const status of [200, 204, 400, 401, 403, 404, 412, 501, 505, 507]) {
			expect(isRetryableStatus(status)).toBe(false);
		}
	});

	it("accepts 2xx only, so a redirect body is never mistaken for content", () => {
		expect(() => assertOk({ status: 200 }, "read", "k")).not.toThrow();
		expect(() => assertOk({ status: 204 }, "read", "k")).not.toThrow();
		expect(() => assertOk({ status: 302 }, "read", "k")).toThrow(
			StorageHttpError,
		);
		expect(() => assertOk({ status: 500 }, "read", "k")).toThrow(/HTTP 500/);
	});

	it("keeps the status on the thrown error", () => {
		try {
			assertOk({ status: 429 }, "write", "objects/abc");
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(StorageHttpError);
			expect((err as StorageHttpError).status).toBe(429);
		}
	});
});

describe("withRetry", () => {
	afterEach(() => vi.useRealTimers());

	it("retries an Android closed stream", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("Request Failed. IOException Stream closed"),
			)
			.mockResolvedValue("ok");
		const pending = expect(withRetry(request)).resolves.toBe("ok");
		await vi.runAllTimersAsync();
		await pending;
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("stops after the bounded retries and preserves the last stream error", async () => {
		vi.useFakeTimers();
		const error = new Error("Request Failed. IOException Stream closed");
		const request = vi.fn().mockRejectedValue(error);
		const pending = expect(withRetry(request)).rejects.toBe(error);
		await vi.runAllTimersAsync();
		await pending;
		expect(request).toHaveBeenCalledTimes(4);
	});

	it.each([
		Object.assign(new Error("Stream closed"), { name: "AbortError" }),
		new StorageHttpError(403, "Stream closed"),
		new Error("Request Failed. IOException Permission denied"),
	])(
		"does not retry cancellation or a definitive failure: %s",
		async (error) => {
			const request = vi.fn().mockRejectedValue(error);
			await expect(withRetry(request)).rejects.toBe(error);
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("retries a retryable failure and returns the eventual success", async () => {
		let attempts = 0;
		const value = await withRetry(async () => {
			attempts++;
			if (attempts < 3) throw new StorageHttpError(503, "later");
			return "ok";
		});
		expect(value).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("gives up immediately on an answer that will not change", async () => {
		let attempts = 0;
		await expect(
			withRetry(async () => {
				attempts++;
				throw new StorageHttpError(403, "denied");
			}),
		).rejects.toThrow(/HTTP 403|denied/);
		expect(attempts).toBe(1);
	});

	it("retries a timeout", async () => {
		let attempts = 0;
		const value = await withRetry(async () => {
			attempts++;
			if (attempts === 1) throw new StorageTimeoutError(10);
			return "ok";
		});
		expect(value).toBe("ok");
		expect(attempts).toBe(2);
	});
});

describe("withTimeout", () => {
	it("rejects when the operation outlives its deadline", async () => {
		const never = new Promise<never>(() => undefined);
		await expect(withTimeout(never, 5)).rejects.toBeInstanceOf(
			StorageTimeoutError,
		);
	});

	it("passes a value through untouched", async () => {
		await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
	});
});

describe("toArrayBuffer", () => {
	it("copies a view rather than exposing its whole backing buffer", () => {
		const backing = new Uint8Array([1, 2, 3, 4, 5]);
		const view = backing.subarray(1, 3);
		const buffer = toArrayBuffer(view);
		expect(new Uint8Array(buffer)).toEqual(new Uint8Array([2, 3]));
	});
});

describe("transfer deadline", () => {
	afterEach(() => vi.useRealTimers());

	const outcome = (promise: Promise<unknown>) =>
		promise.then(
			() => "done",
			(err: unknown) => err,
		);

	it("adds the time the bytes take at 128 KiB/s to the base allowance", async () => {
		vi.useFakeTimers();
		const pending = outcome(
			withDeadline(new Promise<never>(() => undefined), 128 * 1024 * 100),
		);
		await vi.advanceTimersByTimeAsync(129_999);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await pending).toBeInstanceOf(StorageTimeoutError);
	});

	it("keeps 30 s for a request that moves nothing", async () => {
		vi.useFakeTimers();
		const pending = outcome(
			withDeadline(new Promise<never>(() => undefined), 0),
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await pending).toBeInstanceOf(StorageTimeoutError);
	});

	it("takes the body's length, else the expected size", () => {
		expect(transferBytes(new ArrayBuffer(7), 99)).toBe(7);
		expect(transferBytes("abc", 99)).toBe(3);
		expect(transferBytes(undefined, 99)).toBe(99);
		expect(transferBytes(undefined)).toBe(0);
	});

	it("retries the timeout of a small request but not of one over 1 MiB", () => {
		expect(isRetryableError(new StorageTimeoutError(1, 0))).toBe(true);
		expect(isRetryableError(new StorageTimeoutError(1, 1024 * 1024))).toBe(
			true,
		);
		expect(isRetryableError(new StorageTimeoutError(1, 1024 * 1024 + 1))).toBe(
			false,
		);
	});
});
