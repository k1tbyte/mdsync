import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@/app/settings";
import { defaultGoogleDriveConfig } from "@/features/storage/backends/google-drive-auth";
import { defaultS3Config } from "@/features/storage/backends/s3";
import { EStorageBackend } from "@/features/storage/config";
import type { StorageHost } from "@/features/storage/host";
import { createStorageRefusedPrompt } from "@/features/storage/refused-prompt";
import { openStorageRefusedModal } from "@/features/storage/ui/storage-refused-modal";

vi.mock("@/features/storage/ui/storage-refused-modal", () => ({
	openStorageRefusedModal: vi.fn(async () => false),
}));

function host(): StorageHost {
	return {
		settings: mergeSettings({
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: {
				[EStorageBackend.S3]: {
					...defaultS3Config(),
					bucket: "vault",
					accessKeyId: "id",
					secretAccessKey: "old",
				},
			},
		}),
	} as unknown as StorageHost;
}

describe("createStorageRefusedPrompt", () => {
	beforeEach(() => {
		vi.mocked(openStorageRefusedModal).mockClear();
	});

	it("asks once while the keys stay the same", () => {
		const plugin = host();
		const ask = createStorageRefusedPrompt(plugin);
		ask();
		ask();
		expect(openStorageRefusedModal).toHaveBeenCalledExactlyOnceWith(plugin);
	});

	it("asks again once the keys changed, wherever they were fixed", () => {
		const plugin = host();
		const ask = createStorageRefusedPrompt(plugin);
		ask();
		Object.assign(plugin.settings.storageConfigs[EStorageBackend.S3] ?? {}, {
			secretAccessKey: "new",
		});
		ask();
		expect(openStorageRefusedModal).toHaveBeenCalledTimes(2);
	});

	it("does not ask again when Drive only replaced its access token", () => {
		const plugin = host();
		plugin.settings.activeStorageKind = EStorageBackend.GoogleDrive;
		const drive = {
			...defaultGoogleDriveConfig(),
			refreshToken: "r",
			accessToken: "a1",
			expiresAt: 1,
		};
		plugin.settings.storageConfigs[EStorageBackend.GoogleDrive] = drive;
		const ask = createStorageRefusedPrompt(plugin);
		ask();
		Object.assign(drive, { accessToken: "a2", expiresAt: 2 });
		ask();
		expect(openStorageRefusedModal).toHaveBeenCalledOnce();
	});
});
