import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { PassphraseManager } from "@/core/passphrase-manager";
import type { LinkRecord } from "@/links";
import { type MdsyncSettings, mergeSettings } from "@/settings/model";
import { createSettingsTransferUrl } from "@/settings/transfer";
import { SettingsTransferController } from "@/settings/transfer-controller";
import { defaultS3Config } from "@/storage";
import { confirmSettingsTransferImport } from "@/ui";

vi.mock("@/ui", () => ({
	confirmSettingsTransferImport: vi.fn(async () => true),
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
}));

describe("settings transfer passphrase cache", () => {
	it.each([
		{ cachePassphrase: true, brokenKey: false },
		{ cachePassphrase: false, brokenKey: false },
		{ cachePassphrase: true, brokenKey: true },
		{ cachePassphrase: false, brokenKey: true },
	])(
		"preserves the receiving device's cache preference across restart: %j",
		async ({ cachePassphrase, brokenKey }) => {
			const source = mergeSettings({
				storageConfigs: {
					s3: {
						...defaultS3Config(),
						endpoint: "https://s3.example.test",
						bucket: "notes",
						prefix: "vault/",
						secretAccessKey: "S".repeat(44),
					},
				},
			});
			const token = await createSettingsTransferUrl(source, "test-passphrase");
			const settings = mergeSettings({ cachePassphrase });
			const vault = new InMemoryAdapter();
			if (brokenKey) vault.putText(".obsidian/plugins/mdsync/device.key", "");
			const adapter = vault.asDataAdapter();
			const manager = new PassphraseManager(
				async () => "test-passphrase",
				adapter,
				".obsidian",
				settings,
			);
			let saved: MdsyncSettings = settings;
			const transfer = new SettingsTransferController({
				app: {} as App,
				settings,
				passphrase: manager,
				saveSettings: async () => {
					saved = JSON.parse(JSON.stringify(settings));
				},
				onSettingsReplaced: () => {},
			});

			expect(await transfer.importFrom(token)).toBe(true);
			manager.dispose();
			const ask = vi.fn(async () => "test-passphrase");
			const restarted = new PassphraseManager(
				ask,
				adapter,
				".obsidian",
				mergeSettings(saved),
			);
			expect(await restarted.prompt(false)).toBe(true);
			expect(restarted.current()).toBe("test-passphrase");
			expect(ask).toHaveBeenCalledTimes(cachePassphrase ? 0 : 1);
			expect(saved.cachePassphrase).toBe(cachePassphrase);
			expect(saved.storageConfigs.s3).toEqual(source.storageConfigs.s3);
			restarted.dispose();
		},
	);
});

describe("settings import", () => {
	it("keeps a link published while the import was being confirmed", async () => {
		const token = await createSettingsTransferUrl(mergeSettings({}), "pass");
		const settings = mergeSettings({});
		const adapter = new InMemoryAdapter().asDataAdapter();
		const manager = new PassphraseManager(
			async () => "pass",
			adapter,
			".obsidian",
			settings,
		);
		const link: LinkRecord = {
			id: "one",
			url: "https://relay.example/s/one",
			path: "note.md",
			showTitle: true,
			detached: false,
			createdAt: 1,
			publishedAt: 1,
			expires: null,
			maxViews: null,
			salt: null,
			images: false,
		};
		vi.mocked(confirmSettingsTransferImport).mockImplementationOnce(
			async () => {
				settings.links = [link];
				return true;
			},
		);
		const transfer = new SettingsTransferController({
			app: {} as App,
			settings,
			passphrase: manager,
			saveSettings: async () => {},
			onSettingsReplaced: () => {},
		});

		expect(await transfer.importFrom(token)).toBe(true);
		expect(settings.links).toEqual([link]);
		manager.dispose();
	});
});
