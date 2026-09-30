import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";
import {
	EStorageBackend,
	revokeParticipant,
	type S3StorageConfig,
} from "@/storage";
import { notifyInfo } from "@/ui/common/notices";
import { RELAY_TEXT } from "@/ui/common/relay";
import { openConfirmModal } from "@/ui/modals";
import {
	closeShare,
	revokeAccess,
	shareFolder,
} from "@/ui/shares/share-action";

vi.mock("@/ui/actions/ignore-action", () => ({
	carryVaultIgnores: vi.fn(async () => true),
}));
vi.mock("@/ui/actions/push-action", () => ({ pushScope: vi.fn() }));
vi.mock("@/ui/modals", () => ({
	openConfirmModal: vi.fn(async () => false),
}));
vi.mock("@/storage", async (original) => ({
	...(await original<typeof import("@/storage")>()),
	revokeParticipant: vi.fn(async () => {}),
}));
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

describe("closeShare", () => {
	const shared = (relayUrl?: string): SpaceRecord => ({
		id: "s1",
		name: "Team",
		root: "Team",
		rev: 1,
		author: "laptop",
		key: "",
		access: {
			kind: "owner",
			location: {
				endpoint: S3.endpoint,
				region: S3.region,
				bucket: S3.bucket,
				prefix: "vault",
				forcePathStyle: true,
			},
			...(relayUrl ? { relayUrl } : {}),
		},
	});
	const warned = () =>
		vi
			.mocked(openConfirmModal)
			.mock.calls.at(-1)?.[0]
			.body.some((line) => line.includes("keep working there"));

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("warns when the relay the invites went through is not this vault's", async () => {
		await closeShare(host(false).plugin, shared("https://relay.example"));
		expect(warned()).toBe(true);

		await closeShare(host(true).plugin, shared("https://old.example"));
		expect(warned()).toBe(true);
	});

	it("says nothing more when the relay can end the tokens or none went out", async () => {
		await closeShare(host(true).plugin, shared("https://relay.example/"));
		expect(warned()).toBe(false);

		await closeShare(host(false).plugin, shared());
		expect(warned()).toBe(false);
	});
});

describe("revokeAccess", () => {
	const person = { id: "p1", label: "Sam", readOnly: false };
	const team = { id: "s1", name: "Team" } as SpaceRecord;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("ends their access at the relay once the owner confirms", async () => {
		vi.mocked(openConfirmModal).mockResolvedValueOnce(true);

		expect(await revokeAccess(host(true).plugin, team, person)).toBe(true);

		expect(revokeParticipant).toHaveBeenCalledWith(
			{ relayUrl: "https://relay.example", secret: "secret" },
			"s1",
			"p1",
		);
	});

	it("leaves them be when the owner backs out", async () => {
		expect(await revokeAccess(host(true).plugin, team, person)).toBe(false);

		expect(revokeParticipant).not.toHaveBeenCalled();
	});
});
