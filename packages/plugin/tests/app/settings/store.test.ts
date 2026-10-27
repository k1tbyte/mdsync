import { deviceKey, FakeSecretStorage } from "@tests/helpers/device-key";
import { describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@/app/settings";
import { SettingsStore } from "@/app/settings/store";

function plugin(data: Record<string, unknown> | null) {
	return {
		loadData: vi.fn(async () => data),
		saveData: vi.fn(async (_data: unknown) => {}),
	};
}

describe("SettingsStore", () => {
	it("tells a first install from a saved one", async () => {
		const fresh = new SettingsStore(
			plugin(null),
			deviceKey(new FakeSecretStorage()),
		);
		await fresh.load();
		expect(fresh.freshInstall).toBe(true);

		const saved = new SettingsStore(
			plugin({}),
			deviceKey(new FakeSecretStorage()),
		);
		await saved.load();
		expect(saved.freshInstall).toBe(false);
	});

	it("seals secrets an earlier build left in the clear at load", async () => {
		const host = plugin({ relaySecret: "relay-secret" });
		const store = new SettingsStore(host, deviceKey(new FakeSecretStorage()));

		const settings = await store.load();

		expect(settings.relaySecret).toBe("relay-secret");
		expect(host.saveData).toHaveBeenCalledOnce();
		expect(host.saveData.mock.calls[0]?.[0]).not.toHaveProperty("relaySecret");
	});

	it("saves one write at a time, in call order", async () => {
		const host = plugin(null);
		const landed: string[] = [];
		let release: () => void = () => {};
		host.saveData.mockImplementationOnce(async (data) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			landed.push(`first:${(data as { uiLayout?: string }).uiLayout}`);
		});
		host.saveData.mockImplementationOnce(async (data) => {
			landed.push(`second:${(data as { uiLayout?: string }).uiLayout}`);
		});
		const store = new SettingsStore(host, deviceKey(new FakeSecretStorage()));

		const first = store.write(mergeSettings({ uiLayout: "flat" }));
		const second = store.write(mergeSettings({ uiLayout: "tree" }));
		await vi.waitFor(() => expect(host.saveData).toHaveBeenCalledOnce());
		expect(landed).toEqual([]);
		release();
		await Promise.all([first, second]);

		expect(landed).toEqual(["first:flat", "second:tree"]);
	});

	it("keeps writing after one write failed", async () => {
		const host = plugin(null);
		host.saveData.mockRejectedValueOnce(new Error("disk full"));
		const store = new SettingsStore(host, deviceKey(new FakeSecretStorage()));

		await expect(store.write(mergeSettings(null))).rejects.toThrow("disk full");
		await expect(store.write(mergeSettings(null))).resolves.toBeUndefined();
	});
});
