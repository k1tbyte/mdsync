import { describe, expect, it, vi } from "vitest";
import { MdsyncSettingTab } from "@/features/settings/tab";

function tab(listSnapshots: () => Promise<unknown>) {
	const plugin = {
		settings: {
			activeStorageKind: "s3",
			storageConfigs: { s3: { kind: "s3", bucket: "a" } },
		},
		controller: {
			history: { listSnapshots: vi.fn(listSnapshots) },
			vaultCheck: { at: 1 },
			getSnapshot(): { vaultCheck: { at: number } } {
				return { vaultCheck: this.vaultCheck };
			},
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: a partial plugin is enough for the history read.
	const settings = new MdsyncSettingTab({} as any, plugin as any);
	const load = (): Promise<unknown> =>
		(settings as unknown as { loadHistory(): Promise<unknown> }).loadHistory();
	return {
		settings,
		plugin,
		load,
		calls: plugin.controller.history.listSnapshots,
	};
}

describe("MdsyncSettingTab history read", () => {
	it("reads history once per visit, storage and compare", async () => {
		const { settings, plugin, load, calls } = tab(async () => ({}));
		await load();
		await load();
		expect(calls).toHaveBeenCalledTimes(1);

		plugin.settings.storageConfigs.s3.bucket = "b";
		await load();
		expect(calls).toHaveBeenCalledTimes(2);

		plugin.controller.vaultCheck = { at: 2 };
		await load();
		expect(calls).toHaveBeenCalledTimes(3);

		settings.hide();
		await load();
		expect(calls).toHaveBeenCalledTimes(4);
	});

	it("reads again after a failure", async () => {
		const { load, calls } = tab(() => Promise.reject(new Error("offline")));
		await expect(load()).rejects.toThrow("offline");
		await expect(load()).rejects.toThrow("offline");
		expect(calls).toHaveBeenCalledTimes(2);
	});
});
