import { afterEach, describe, expect, it } from "vitest";

import { sessionCache } from "../src/cache";

const link = {
	sealed: new Uint8Array([1, 2, 3]),
	protected: false,
	salt: null,
	viewsLeft: 2,
	expires: 1_900_000_000,
};

const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

afterEach(() => {
	if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
	sessionStorage.clear();
});

describe("session cache", () => {
	it.each([link.expires, null])("round-trips an expiry of %s", (expires) => {
		const cache = sessionCache();
		const entry = { ...link, expires };
		cache.put("id", entry);
		expect(cache.get("id")).toEqual(entry);
	});

	it("works without a cache when the browser blocks storage", () => {
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			get() {
				throw new DOMException("Blocked", "SecurityError");
			},
		});
		const cache = sessionCache();
		expect(() => cache.put("id", link)).not.toThrow();
		expect(cache.get("id")).toBeNull();
	});
});
