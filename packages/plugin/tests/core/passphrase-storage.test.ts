import type { DataAdapter } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { PassphraseManager } from "@/core/passphrase-manager";
import type { DeviceKey } from "@/crypto/device-key";
import { DEFAULT_SETTINGS } from "@/settings/model";

const created = vi.hoisted(() => ({ changed: null as (() => void) | null }));
vi.mock("@/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/storage")>()),
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
