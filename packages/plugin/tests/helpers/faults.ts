import { vi } from "vitest";
import { InMemoryAdapter } from "./in-memory-adapter";

/**
 * Kills the next write `matches` part way, as Obsidian leaves it: it truncates before it writes, and mobile drops
 * a file whose append fails. Returns whether it fired.
 */
export function killNextWrite(
	adapter: InMemoryAdapter,
	matches: (path: string) => boolean,
	leaves: "prefix" | "nothing",
): () => boolean {
	const write = InMemoryAdapter.prototype.writeBinary.bind(adapter);
	let fired = false;
	vi.spyOn(adapter, "writeBinary").mockImplementation(async (path, data) => {
		if (fired || !matches(path)) return write(path, data);
		fired = true;
		if (leaves === "prefix") {
			await write(path, data.slice(0, Math.floor(data.byteLength / 2)));
		} else {
			await adapter.remove(path);
		}
		throw new Error("killed mid-write");
	});
	return () => fired;
}

/** An I/O error on matching paths as mobile reports one: `exists()` false, `stat` and reads throwing. */
export function failIo(
	adapter: InMemoryAdapter,
	matches: (path: string) => boolean,
): void {
	const real = InMemoryAdapter.prototype;
	const fail = (path: string) => Promise.reject(new Error(`EIO: ${path}`));
	vi.spyOn(adapter, "exists").mockImplementation(
		async (path) => !matches(path) && real.exists.call(adapter, path),
	);
	vi.spyOn(adapter, "stat").mockImplementation((path) =>
		matches(path) ? fail(path) : real.stat.call(adapter, path),
	);
	vi.spyOn(adapter, "read").mockImplementation((path) =>
		matches(path) ? fail(path) : real.read.call(adapter, path),
	);
	vi.spyOn(adapter, "readBinary").mockImplementation((path) =>
		matches(path) ? fail(path) : real.readBinary.call(adapter, path),
	);
}
