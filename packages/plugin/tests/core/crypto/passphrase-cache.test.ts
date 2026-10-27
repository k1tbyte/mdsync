import { deviceKey, FakeSecretStorage } from "@tests/helpers/device-key";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	loadCachedPassphrase,
	saveCachedPassphrase,
} from "@/core/crypto/passphrase-cache";

const cachePath = ".obsidian/plugins/mdsync/passphrase.enc";
const binding = "s3|example|region|bucket|prefix";
afterEach(() => vi.restoreAllMocks());

describe("passphrase cache", () => {
	it("opens on the next launch and stays bound to its storage", async () => {
		const adapter = new InMemoryAdapter().asDataAdapter();
		const secrets = new FakeSecretStorage();
		await saveCachedPassphrase(
			adapter,
			".obsidian",
			deviceKey(secrets, adapter),
			"passphrase",
			binding,
		);

		const restarted = deviceKey(secrets, adapter);
		expect(
			await loadCachedPassphrase(
				adapter,
				".obsidian",
				restarted,
				"other-storage",
			),
		).toBeNull();
		expect(
			await loadCachedPassphrase(adapter, ".obsidian", restarted, binding),
		).toBe("passphrase");
	});

	it("is unreadable in a copy of the vault on another device", async () => {
		const adapter = new InMemoryAdapter().asDataAdapter();
		await saveCachedPassphrase(
			adapter,
			".obsidian",
			deviceKey(new FakeSecretStorage(), adapter),
			"passphrase",
			binding,
		);
		const elsewhere = deviceKey(new FakeSecretStorage(), adapter);

		expect(
			await loadCachedPassphrase(adapter, ".obsidian", elsewhere, binding),
		).toBeNull();
		expect(await elsewhere.read()).toBeNull();
	});

	it("rebuilds its key only when saving an available passphrase", async () => {
		const vault = new InMemoryAdapter();
		vault.putText(cachePath, "unreadable cache");
		const adapter = vault.asDataAdapter();
		const key = deviceKey(new FakeSecretStorage(), adapter);

		expect(
			await loadCachedPassphrase(adapter, ".obsidian", key, binding),
		).toBeNull();
		expect(await key.read()).toBeNull();
		await saveCachedPassphrase(adapter, ".obsidian", key, "entered", binding);
		expect(await loadCachedPassphrase(adapter, ".obsidian", key, binding)).toBe(
			"entered",
		);
	});

	it("reports a real write failure without claiming that the cache was saved", async () => {
		const adapter = new InMemoryAdapter().asDataAdapter();
		vi.spyOn(adapter, "writeBinary").mockRejectedValue(new Error("disk full"));
		await expect(
			saveCachedPassphrase(
				adapter,
				".obsidian",
				deviceKey(new FakeSecretStorage(), adapter),
				"entered",
				binding,
			),
		).rejects.toThrow("disk full");
	});
});
