import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";
import { EStorageBackend, type S3StorageConfig } from "@/storage";
import { notifyInfo } from "@/ui/common/notices";
import { RELAY_TEXT } from "@/ui/live/relay-text";
import { shareFolder } from "@/ui/shares/share-action";

vi.mock("@/ui/actions/ignore-action", () => ({
	carryVaultIgnores: vi.fn(async () => true),
}));
vi.mock("@/ui/actions/push-action", () => ({ pushScope: vi.fn() }));
vi.mock("@/ui/common/notices", () => ({
	notifyInfo: vi.fn(),
	notifyError: vi.fn(),
}));

const S3: S3StorageConfig = {
	kind: EStorageBackend.S3,
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "/vault/",
	accessKeyId: "id",
	secretAccessKey: "secret",
	forcePathStyle: true,
	concurrency: 4,
};

function host(relay: boolean) {
	const added: SpaceRecord[] = [];
	const plugin = {
		app: {},
		settings: {
			activeStorageKind: EStorageBackend.S3,
			storageConfigs: { [EStorageBackend.S3]: S3 },
			relayUrl: relay ? "https://relay.example" : "",
			relaySecret: relay ? "secret" : "",
		},
		spaces: {
			partition: () => [],
			add: async (record: SpaceRecord) => void added.push(record),
		},
		ignoreState: { refresh: async () => {} },
		controller: { currentDevice: () => ({ id: "laptop" }) },
	} as unknown as PluginHost;
	return { plugin, added };
}

describe("shareFolder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shares without a relay and says an invite needs one", async () => {
		const { plugin, added } = host(false);

		const record = await shareFolder(plugin, "Team");

		expect(added).toEqual([record]);
		expect(notifyInfo).toHaveBeenCalledWith(
			expect.stringContaining(RELAY_TEXT["no-relay"]),
		);
	});

	it("says nothing about the relay when one is set up", async () => {
		const { plugin, added } = host(true);

		await shareFolder(plugin, "Team");

		expect(notifyInfo).not.toHaveBeenCalledWith(
			expect.stringContaining(RELAY_TEXT["no-relay"]),
		);
		expect(added).toHaveLength(1);
	});
});
