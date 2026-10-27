import { deviceKey, FakeSecretStorage } from "@tests/helpers/device-key";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@/app/settings";
import type { MdsyncSettings } from "@/core/settings/model";
import type { LinkRecord } from "@/features/links/record";
import { defaultS3Config } from "@/features/storage/backends/s3";
import { PassphraseManager } from "@/features/sync/remote/passphrase-manager";
import {
	createSettingsTransferUrl,
	ESettingsTransferStorageMode,
} from "@/features/transfer/transfer";
import { SettingsTransferController } from "@/features/transfer/transfer-controller";
import { confirmSettingsTransferImport } from "@/features/transfer/ui/settings-transfer-modal";

vi.mock("@/features/transfer/ui/settings-transfer-modal", () => ({
	confirmSettingsTransferImport: vi.fn(async () => true),
}));
vi.mock("@/core/ui/notices", () => ({
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
			const adapter = new InMemoryAdapter().asDataAdapter();
			const secrets = new FakeSecretStorage();
			if (brokenKey) secrets.setSecret("mdsync-device-key", "");
			const manager = new PassphraseManager(
				async () => "test-passphrase",
				adapter,
				".obsidian",
				settings,
				deviceKey(secrets, adapter),
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
				deviceKey(secrets, adapter),
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
			deviceKey(new FakeSecretStorage(), adapter),
		);
		const link: LinkRecord = {
			id: "one",
			url: "https://relay.example/s/one",
			rev: 0,
			author: "",
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

describe("settings import with a typed passphrase", () => {
	const SOURCE_S3 = {
		...defaultS3Config(),
		endpoint: "https://s3.example.test",
		bucket: "notes",
		prefix: "vault/",
		accessKeyId: "AK",
		secretAccessKey: "S".repeat(44),
	};

	function setup() {
		vi.mocked(confirmSettingsTransferImport).mockClear();
		const settings = mergeSettings({});
		const manager = new PassphraseManager(
			async () => null,
			new InMemoryAdapter().asDataAdapter(),
			".obsidian",
			settings,
			deviceKey(),
		);
		const saveSettings = vi.fn(async () => {});
		const onSettingsReplaced = vi.fn();
		const transfer = new SettingsTransferController({
			app: {} as App,
			settings,
			passphrase: manager,
			saveSettings,
			onSettingsReplaced,
		});
		return { settings, manager, saveSettings, onSettingsReplaced, transfer };
	}

	it("applies the link without asking, saves it and adopts the passphrase", async () => {
		const token = await createSettingsTransferUrl(
			mergeSettings({ storageConfigs: { s3: SOURCE_S3 } }),
			"pass",
		);
		const { settings, manager, saveSettings, onSettingsReplaced, transfer } =
			setup();

		await transfer.importWith(token, "pass");

		expect(settings.storageConfigs.s3).toEqual(SOURCE_S3);
		expect(saveSettings).toHaveBeenCalledOnce();
		expect(onSettingsReplaced).toHaveBeenCalledOnce();
		expect(manager.current()).toBe("pass");
		expect(confirmSettingsTransferImport).not.toHaveBeenCalled();
		manager.dispose();
	});

	it("keeps this device's passphrase when the link carries no storage", async () => {
		const token = await createSettingsTransferUrl(
			mergeSettings({ autoSyncEnabled: true }),
			"other",
			{ storageMode: ESettingsTransferStorageMode.None },
		);
		const { manager, transfer } = setup();
		await manager.replacePassphrase("mine");

		await transfer.importWith(token, "other");

		expect(manager.current()).toBe("mine");
		manager.dispose();
	});

	it("rejects a wrong passphrase and leaves the settings untouched", async () => {
		const token = await createSettingsTransferUrl(
			mergeSettings({ storageConfigs: { s3: SOURCE_S3 } }),
			"pass",
		);
		const { settings, manager, saveSettings, onSettingsReplaced, transfer } =
			setup();
		const before = JSON.parse(JSON.stringify(settings));

		await expect(transfer.importWith(token, "wrong")).rejects.toThrow();

		expect(JSON.parse(JSON.stringify(settings))).toEqual(before);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(onSettingsReplaced).not.toHaveBeenCalled();
		expect(manager.has()).toBe(false);
		manager.dispose();
	});
});
