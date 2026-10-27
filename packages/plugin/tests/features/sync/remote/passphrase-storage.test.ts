import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/settings";
import type { DeviceKey } from "@/core/crypto/device-key";
import { PassphraseManager } from "@/features/sync/remote/passphrase-manager";

const created = vi.hoisted(() => ({ changed: null as (() => void) | null }));
vi.mock("@/features/storage/registry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/features/storage/registry")>()),
	createStorageAdapter: (_config: unknown, changed?: () => void) => {
		created.changed = changed ?? null;
		return {};
	},
}));

describe("the vault storage outside a session", () => {
	it("saves the settings when its adapter rewrites its config, as a refreshed Drive token", () => {
		const persist = vi.fn(async () => undefined);
		const manager = new PassphraseManager(
			async () => null,
			{} as DataAdapter,
			".obsidian",
			DEFAULT_SETTINGS,
			{} as DeviceKey,
			persist,
		);

		manager.storage();
		created.changed?.();

		expect(persist).toHaveBeenCalledOnce();
	});
});
