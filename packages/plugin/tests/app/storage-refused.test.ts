import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { mergeSettings } from "@/app/settings";
import { createStorageRefused } from "@/app/storage-refused";
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

describe("createStorageRefused", () => {
	beforeEach(() => {
		vi.mocked(openStorageRefusedModal).mockClear();
	});

	it("asks for the vault", () => {
		const plugin = host();
		createStorageRefused(plugin)(VAULT_SPACE);
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
});
