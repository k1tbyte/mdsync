import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { createStorageRefused } from "@/app/storage-refused";
import { mergeSettings } from "@/core/settings/model";
import { defaultGoogleDriveConfig } from "@/features/storage/backends/google-drive-auth";
import { defaultS3Config } from "@/features/storage/backends/s3";
import { EStorageBackend } from "@/features/storage/config";
import { openStorageRefusedModal } from "@/features/storage/ui/storage-refused-modal";
import { VAULT_SPACE } from "@/features/sync/remote/space";

vi.mock("@/features/storage/ui/storage-refused-modal", () => ({
	openStorageRefusedModal: vi.fn(async () => false),
}));

const owned = { id: "owned", root: "Team" };
const joined = { id: "joined", root: "Other" };

function host(): PluginHost {
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
		spaces: {
			get: (id: string) =>
				id === owned.id
					? { access: { kind: "owner" } }
					: id === joined.id
						? { access: { kind: "participant" } }
						: undefined,
		},
	} as unknown as PluginHost;
}

function rekey(plugin: PluginHost, secret: string): void {
	Object.assign(plugin.settings.storageConfigs[EStorageBackend.S3] ?? {}, {
		secretAccessKey: secret,
	});
}

describe("createStorageRefused", () => {
	beforeEach(() => {
		vi.mocked(openStorageRefusedModal).mockClear();
	});

	it("asks once for the vault while its keys stay the same", () => {
		const plugin = host();
		const refused = createStorageRefused(plugin);
		refused(VAULT_SPACE);
		refused(VAULT_SPACE);
		expect(openStorageRefusedModal).toHaveBeenCalledExactlyOnceWith(plugin);
	});

	it("asks for an owned share", () => {
		createStorageRefused(host())(owned);
		expect(openStorageRefusedModal).toHaveBeenCalledOnce();
	});

	it("never asks for a participant's share, nor spends the ask on one", () => {
		const refused = createStorageRefused(host());
		refused(joined);
		expect(openStorageRefusedModal).not.toHaveBeenCalled();
		refused(VAULT_SPACE);
		expect(openStorageRefusedModal).toHaveBeenCalledOnce();
	});

	it("asks again once the keys changed, wherever they were fixed", () => {
		const plugin = host();
		const refused = createStorageRefused(plugin);
		refused(VAULT_SPACE);
		rekey(plugin, "new");
		refused(VAULT_SPACE);
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
		const refused = createStorageRefused(plugin);
		refused(VAULT_SPACE);
		Object.assign(drive, { accessToken: "a2", expiresAt: 2 });
		refused(VAULT_SPACE);
		expect(openStorageRefusedModal).toHaveBeenCalledOnce();
	});
});
