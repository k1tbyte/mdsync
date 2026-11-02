import { deviceKey, FakeSecretStorage } from "@tests/helpers/device-key";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { describe, expect, it, vi } from "vitest";

import { decryptJson, encryptJson, importAesKey } from "@/core/crypto/cipher";

vi.mock("@/core/shared/diagnostics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	reportWarning: vi.fn(),
}));

const LEGACY = ".obsidian/plugins/mdsync/device.key";
const SECRET = "mdsync-device-key";

describe("DeviceKey", () => {
	it("has none until one is needed, then one for every caller and every launch", async () => {
		const secrets = new FakeSecretStorage();
		const key = deviceKey(secrets);
		expect(await key.read()).toBeNull();
		expect(secrets.map.size).toBe(0);

		const [first, second] = await Promise.all([
			key.readOrCreate(),
			key.readOrCreate(),
		]);
		expect(first).toBe(second);
		expect(await key.read()).toBe(first);
		expect(secrets.listSecrets()).toEqual([SECRET]);

		const sealed = await encryptJson(first, { a: 1 });
		const restarted = await deviceKey(secrets).read();
		expect(restarted && (await decryptJson(restarted, sealed))).toEqual({
			a: 1,
		});
	});

	it("replaces a key the keychain holds damaged", async () => {
		const secrets = new FakeSecretStorage();
		secrets.setSecret(SECRET, "not a key");
		const key = deviceKey(secrets);

		expect(await key.read()).toBeNull();
		await key.readOrCreate();
		expect(secrets.getSecret(SECRET)).not.toBe("not a key");
	});

	it("moves an earlier build's key file into the keychain, so what it sealed still opens", async () => {
		const vault = new InMemoryAdapter();
		const bytes = new Uint8Array(32).fill(7);
		const sealed = await encryptJson(await importAesKey(bytes), { a: 1 });
		vault.putText(LEGACY, "\x07".repeat(32));
		const secrets = new FakeSecretStorage();

		const key = await deviceKey(secrets, vault.asDataAdapter()).read();

		expect(key && (await decryptJson(key, sealed))).toEqual({ a: 1 });
		expect(vault.hasFile(LEGACY)).toBe(false);
	});

	it("deletes a leftover key file without letting it replace the keychain's", async () => {
		const vault = new InMemoryAdapter();
		vault.putText(LEGACY, "x".repeat(32));
		const secrets = new FakeSecretStorage();
		secrets.setSecret(SECRET, "kept");

		await deviceKey(secrets, vault.asDataAdapter()).read();

		expect(secrets.getSecret(SECRET)).toBe("kept");
		expect(vault.hasFile(LEGACY)).toBe(false);
	});

	it("drops a damaged key file and starts without a key", async () => {
		const vault = new InMemoryAdapter();
		vault.putText(LEGACY, "short");
		const secrets = new FakeSecretStorage();

		expect(await deviceKey(secrets, vault.asDataAdapter()).read()).toBeNull();
		expect(secrets.map.size).toBe(0);
		expect(vault.hasFile(LEGACY)).toBe(false);
	});

	it("tries the move again at the next launch when deleting the file failed", async () => {
		const vault = new InMemoryAdapter();
		vault.putText(LEGACY, "x".repeat(32));
		const adapter = vault.asDataAdapter();
		vi.spyOn(adapter, "remove").mockRejectedValueOnce(new Error("busy"));
		const secrets = new FakeSecretStorage();

		expect(await deviceKey(secrets, adapter).read()).not.toBeNull();
		expect(vault.hasFile(LEGACY)).toBe(true);

		await deviceKey(secrets, adapter).read();
		expect(vault.hasFile(LEGACY)).toBe(false);
	});
});
