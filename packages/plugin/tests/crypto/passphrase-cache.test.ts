import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_KEY_BYTES } from "@/crypto/constants";
import {
	loadCachedPassphrase,
	saveCachedPassphrase,
} from "@/crypto/passphrase-cache";

const keyPath = ".obsidian/plugins/obsync/device.key";
const cachePath = ".obsidian/plugins/obsync/passphrase.enc";
const binding = "s3|example|region|bucket|prefix";
afterEach(() => vi.restoreAllMocks());

describe("passphrase cache recovery", () => {
	it.each([0, 16, 31, 33])(
		"rebuilds a %i-byte key only when saving an available passphrase",
		async (length) => {
			const vault = new InMemoryAdapter();
			vault.putText(keyPath, "x".repeat(length));
			vault.putText(cachePath, "unreadable cache");
			const adapter = vault.asDataAdapter();
			const writes = vi.spyOn(adapter, "writeBinary");

			expect(
				await loadCachedPassphrase(adapter, ".obsidian", binding),
			).toBeNull();
			expect(writes).not.toHaveBeenCalled();
			expect(vault.readText(keyPath)).toBe("x".repeat(length));
			await saveCachedPassphrase(
				adapter,
				".obsidian",
				"entered-passphrase",
				binding,
			);
			expect((await adapter.readBinary(keyPath)).byteLength).toBe(
				DEVICE_KEY_BYTES,
			);
			expect(await loadCachedPassphrase(adapter, ".obsidian", binding)).toBe(
				"entered-passphrase",
			);
		},
	);

	it("rebuilds an unreadable key when the new cache can be written", async () => {
		const vault = new InMemoryAdapter();
		const adapter = vault.asDataAdapter();
		await saveCachedPassphrase(adapter, ".obsidian", "old-passphrase", binding);
		vi.spyOn(adapter, "readBinary").mockRejectedValueOnce(
			new Error("Could not read device key"),
		);
		await saveCachedPassphrase(
			adapter,
			".obsidian",
			"entered-passphrase",
			binding,
		);
		expect(await loadCachedPassphrase(adapter, ".obsidian", binding)).toBe(
			"entered-passphrase",
		);
	});

	it("reuses a valid key and keeps the cache bound to its storage", async () => {
		const vault = new InMemoryAdapter();
		const adapter = vault.asDataAdapter();
		await saveCachedPassphrase(adapter, ".obsidian", "old-passphrase", binding);
		const key = await adapter.readBinary(keyPath);
		await saveCachedPassphrase(adapter, ".obsidian", "new-passphrase", binding);
		expect(await adapter.readBinary(keyPath)).toEqual(key);
		expect(
			await loadCachedPassphrase(adapter, ".obsidian", "other-storage"),
		).toBeNull();
		expect(await loadCachedPassphrase(adapter, ".obsidian", binding)).toBe(
			"new-passphrase",
		);
	});

	it("reports a real write failure without claiming that the cache was saved", async () => {
		const vault = new InMemoryAdapter();
		vault.putText(keyPath, "");
		const adapter = vault.asDataAdapter();
		vi.spyOn(adapter, "writeBinary").mockRejectedValue(new Error("disk full"));
		await expect(
			saveCachedPassphrase(adapter, ".obsidian", "entered-passphrase", binding),
		).rejects.toThrow("disk full");
	});
});
