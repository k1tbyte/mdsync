import { webcrypto } from "node:crypto";

// Polyfill window, window.crypto and requestAnimationFrame for the Node test runner.
const g = globalThis as Record<string, unknown>;

if (g.crypto === undefined) {
	g.crypto = webcrypto;
}

if (g.window === undefined) {
	g.window = globalThis;
}

// Node's navigator has no onLine; every browser reports one, and `!navigator.onLine` means offline.
if (typeof navigator !== "undefined" && navigator.onLine === undefined) {
	Object.defineProperty(navigator, "onLine", {
		value: true,
		configurable: true,
	});
}

if (g.localStorage === undefined) {
	const items = new Map<string, string>();
	g.localStorage = {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => items.set(key, String(value)),
		removeItem: (key: string) => items.delete(key),
		clear: () => items.clear(),
	};
}

// Resolves setTimeout at call time, so fake timers drive frames too.
if (g.requestAnimationFrame === undefined) {
	g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
	g.cancelAnimationFrame = (id: number) => clearTimeout(id);
}
