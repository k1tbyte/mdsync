import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { describe, expect, it } from "vitest";
import { loadLocalCopy } from "@/features/sync/changes/content";
import { LARGE_FILE_BYTES } from "@/features/sync/changes/file-concurrency";

describe("loadLocalCopy", () => {
	const MB = 1024 * 1024;

	async function disk(size: number) {
		const adapter = new InMemoryAdapter();
		await adapter.writeBinary("big.bin", new ArrayBuffer(size));
		return adapter.asDataAdapter();
	}

	it("reads a copy no bigger than the remote file, or below the large-file mark", async () => {
		expect(
			await loadLocalCopy(await disk(MB), "big.bin", 256 * 1024),
		).toHaveLength(MB);
		const large = LARGE_FILE_BYTES + MB;
		expect(
			await loadLocalCopy(await disk(large), "big.bin", large),
		).toHaveLength(large);
	});

	it("skips a large copy of a file pulled as small, and a missing one", async () => {
		const adapter = await disk(LARGE_FILE_BYTES + MB);
		expect(await loadLocalCopy(adapter, "big.bin", 256 * 1024)).toBeNull();
		expect(await loadLocalCopy(adapter, "gone.bin", 256 * 1024)).toBeNull();
	});
});
