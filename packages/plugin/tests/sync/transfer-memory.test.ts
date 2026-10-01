import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";

import { pullPaths, pushPaths } from "@/sync/engine";
import { LARGE_FILE_BYTES } from "@/utils/file-concurrency";

useEncryptionKey();

const paths = ["a.bin", "b.bin", "c.bin", "d.bin"];
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("transfer memory lanes", () => {
	it("admits only one large upload through read, hash, encryption and PUT", async () => {
		const [a] = pairedSessions();
		for (const path of paths) a.adapter.putText(path, path);
		const result = await a.compare();
		for (const entry of Object.values(result.snapshot.files))
			entry.size = LARGE_FILE_BYTES;
		const adapter = a.adapter.asDataAdapter();
		const read = adapter.readBinary.bind(adapter);
		const put = a.storage.put.bind(a.storage);
		let active = 0;
		let peak = 0;
		vi.spyOn(adapter, "readBinary").mockImplementation(async (path) => {
			peak = Math.max(peak, ++active);
			return read(path);
		});
		vi.spyOn(a.storage, "put").mockImplementation(async (...args) => {
			await put(...args);
			if (!args[0].startsWith("objects/")) return;
			await pause();
			active--;
		});
		await pushPaths({ ...a.deps(), concurrency: 4 }, result, paths);
		expect(peak).toBe(1);
		expect(active).toBe(0);
	});

	it("admits only one large download through GET, decryption and disk write", async () => {
		const [a, b] = pairedSessions();
		for (const path of paths) a.adapter.putText(path, path);
		const first = await a.compare();
		for (const entry of Object.values(first.snapshot.files))
			entry.size = LARGE_FILE_BYTES;
		await pushPaths(a.deps(), first, paths);
		const result = await b.compare();
		const get = b.storage.get.bind(b.storage);
		const adapter = b.adapter.asDataAdapter();
		const write = adapter.writeBinary.bind(adapter);
		let active = 0;
		let peak = 0;
		vi.spyOn(b.storage, "get").mockImplementation(async (path) => {
			if (path.startsWith("objects/")) peak = Math.max(peak, ++active);
			return get(path);
		});
		vi.spyOn(adapter, "writeBinary").mockImplementation(async (...args) => {
			await pause();
			await write(...args);
			active--;
		});
		const pulled = await pullPaths(
			{ ...b.deps(), concurrency: 4 },
			result,
			paths,
		);
		expect(peak).toBe(1);
		expect(active).toBe(0);
		expect(pulled.written.size).toBe(4);
	});
});
