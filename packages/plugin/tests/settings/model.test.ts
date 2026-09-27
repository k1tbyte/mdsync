import { describe, expect, it } from "vitest";
import { AUTO_PUSH_SETTLE_MAX_SECONDS } from "@/constants";
import { DEFAULT_SETTINGS, mergeSettings } from "@/settings/model";
import { EStorageBackend, type StorageAdapterConfig } from "@/storage/config";

describe("mergeSettings", () => {
	it("requires opt-in for every configuration category on a fresh device", () => {
		expect(Object.values(mergeSettings(null).settingsSync)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
		expect(
			mergeSettings({
				settingsSync: { ...DEFAULT_SETTINGS.settingsSync, snippets: true },
			}).settingsSync.snippets,
		).toBe(true);
	});
	it("defaults historyAutoRefresh to true when absent", () => {
		expect(mergeSettings(null).historyAutoRefresh).toBe(true);
		expect(mergeSettings({}).historyAutoRefresh).toBe(true);
	});

	it("preserves an explicit historyAutoRefresh: false", () => {
		expect(
			mergeSettings({ historyAutoRefresh: false }).historyAutoRefresh,
		).toBe(false);
	});

	it("shows file sizes by default and preserves an explicit false", () => {
		expect(mergeSettings(null).showFileSizes).toBe(true);
		expect(mergeSettings({ showFileSizes: false }).showFileSizes).toBe(false);
	});

	it("keeps only folder paths in the pending share moves", () => {
		const localRoots = { a: "Team", b: "", c: 3 } as unknown as Record<
			string,
			string
		>;
		expect(mergeSettings({ localRoots }).localRoots).toEqual({ a: "Team" });
		expect(mergeSettings(null).localRoots).toEqual({});
	});

	it("drops the retired relay and broker fields but keeps the relay config", () => {
		const merged = mergeSettings({
			relayUrl: "https://relay.example",
			relaySecret: "secret",
			realtimeToken: "old-token",
			shareBrokerAdminSecret: "old-admin",
		} as Parameters<typeof mergeSettings>[0]);

		expect(merged).toMatchObject({
			relayUrl: "https://relay.example",
			relaySecret: "secret",
		});
		expect(merged).not.toHaveProperty("realtimeToken");
		expect(merged).not.toHaveProperty("shareBrokerAdminSecret");
	});

	it("backfills missing per-storage concurrency from backend defaults", () => {
		const merged = mergeSettings({
			activeStorageKind: EStorageBackend.GoogleDrive,
			storageConfigs: {
				[EStorageBackend.GoogleDrive]: {
					kind: EStorageBackend.GoogleDrive,
					folderName: "ObsidianSync",
					clientId: "",
					authServerUrl: "https://x",
					accessToken: "",
					refreshToken: "",
					expiresAt: 0,
				},
				[EStorageBackend.S3]: {
					kind: EStorageBackend.S3,
					endpoint: "",
					region: "auto",
					bucket: "b",
					prefix: "",
					accessKeyId: "",
					secretAccessKey: "",
					forcePathStyle: true,
				},
			} as unknown as Record<string, StorageAdapterConfig>,
		});
		expect(
			merged.storageConfigs[EStorageBackend.GoogleDrive]?.concurrency,
		).toBe(8);
		expect(merged.storageConfigs[EStorageBackend.S3]?.concurrency).toBe(4);
	});

	it("drops a storage config naming a backend this build no longer has", () => {
		const merged = mergeSettings({
			activeStorageKind: "share-broker" as EStorageBackend,
			storageConfigs: {
				"share-broker": { kind: "share-broker", brokerUrl: "https://x" },
			} as unknown as Record<string, StorageAdapterConfig>,
		});

		expect(merged.storageConfigs).not.toHaveProperty("share-broker");
		expect(merged.activeStorageKind).toBe(EStorageBackend.S3);
	});

	it("replaces an invalid concurrency with the backend default", () => {
		const merged = mergeSettings({
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: {
				[EStorageBackend.S3]: {
					kind: EStorageBackend.S3,
					endpoint: "",
					region: "auto",
					bucket: "b",
					prefix: "",
					accessKeyId: "",
					secretAccessKey: "",
					forcePathStyle: true,
					concurrency: 0,
				},
			},
		});
		expect(merged.storageConfigs[EStorageBackend.S3]?.concurrency).toBe(4);
	});
});

describe("mergeSettings clamps", () => {
	it("refuses a negative or zero value and falls back to the default", () => {
		const merged = mergeSettings({
			autoSyncIntervalMinutes: -5,
			autoPushSettleSeconds: 0,
			maxFileBytes: 0,
			fileHistoryMaxSnapshots: 0,
		});

		expect(merged.autoSyncIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoSyncIntervalMinutes,
		);
		expect(merged.autoPushSettleSeconds).toBe(
			DEFAULT_SETTINGS.autoPushSettleSeconds,
		);
		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.fileHistoryMaxSnapshots).toBe(
			DEFAULT_SETTINGS.fileHistoryMaxSnapshots,
		);
	});

	it("caps a value that is merely greedy", () => {
		const merged = mergeSettings({
			autoSyncIntervalMinutes: 999_999,
			autoPushSettleSeconds: 999,
			fileHistoryMaxSnapshots: 1e9,
		});

		expect(merged.autoSyncIntervalMinutes).toBe(24 * 60);
		expect(merged.autoPushSettleSeconds).toBe(AUTO_PUSH_SETTLE_MAX_SECONDS);
		expect(merged.fileHistoryMaxSnapshots).toBe(1000);
	});

	it("ignores a number that is not one", () => {
		const merged = mergeSettings({
			maxFileBytes: Number.NaN,
			autoSyncIntervalMinutes: "10" as unknown as number,
		});

		expect(merged.maxFileBytes).toBe(DEFAULT_SETTINGS.maxFileBytes);
		expect(merged.autoSyncIntervalMinutes).toBe(
			DEFAULT_SETTINGS.autoSyncIntervalMinutes,
		);
	});

	it("keeps a value that is already in range", () => {
		expect(
			mergeSettings({ autoSyncIntervalMinutes: 15 }).autoSyncIntervalMinutes,
		).toBe(15);
	});

	it("keeps an explicit autosync toggle and push preference", () => {
		const merged = mergeSettings({
			autoSyncEnabled: false,
			autoSyncIntervalMinutes: 30,
			autoPushAfterSync: false,
		});
		expect(merged.autoSyncEnabled).toBe(false);
		expect(merged.autoPushAfterSync).toBe(false);
	});
});
