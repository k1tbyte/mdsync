import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PassphraseManager } from "@/core";
import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { createSpaceAccess } from "@/plugin/space-access";
import { DEFAULT_SETTINGS, type ObsyncSettings } from "@/settings/model";
import { VAULT_SPACE } from "@/sync/space";

vi.mock("@/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/storage")>()),
	createStorageAdapter: () => ({}),
}));
vi.mock("@/shared/diagnostics", () => ({ reportWarning: vi.fn() }));

const RETRY_MS = 30_000;

let keys: LiveKeys;
let unlocked: boolean;
let resolveKey: ReturnType<typeof vi.fn>;
let access: ReturnType<typeof createSpaceAccess>;

function settings(): ObsyncSettings {
	return {
		...DEFAULT_SETTINGS,
		realtimeSync: true,
		activeStorageKind: "s3",
		storageConfigs: {
			s3: {
				kind: "s3",
				endpoint: "https://s3.example",
				region: "auto",
				bucket: "notes",
				prefix: "vault",
				accessKeyId: "id",
				secretAccessKey: "key",
				forcePathStyle: true,
				concurrency: 4,
			},
		},
	} as ObsyncSettings;
}

beforeEach(async () => {
	vi.useFakeTimers();
	keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	unlocked = false;
	resolveKey = vi.fn(async () => {
		unlocked = true;
	});
	const passphrase = {
		has: () => true,
		liveKeys: () => (unlocked ? keys : null),
		resolveKey,
	} as unknown as PassphraseManager;
	access = createSpaceAccess({
		passphrase,
		controller: { currentDevice: () => ({ id: "d1", name: "laptop" }) },
		settings,
	} as Parameters<typeof createSpaceAccess>[0]);
});

afterEach(() => vi.useRealTimers());

describe("vault key unlock", () => {
	it("is one unlock for every caller asking while it runs", async () => {
		const answers = await Promise.all([
			access(VAULT_SPACE),
			access(VAULT_SPACE),
			access(VAULT_SPACE),
		]);

		expect(resolveKey).toHaveBeenCalledOnce();
		for (const answer of answers) expect(answer?.keys).toBe(keys);
	});

	it("is not repeated once it worked", async () => {
		await access(VAULT_SPACE);
		await access(VAULT_SPACE);

		expect(resolveKey).toHaveBeenCalledOnce();
	});

	it("pauses after a failure, then tries again", async () => {
		resolveKey.mockRejectedValueOnce(new Error("offline"));

		expect(await access(VAULT_SPACE)).toBeNull();
		await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
		expect(await access(VAULT_SPACE)).toBeNull();
		expect(resolveKey).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1);
		expect((await access(VAULT_SPACE))?.keys).toBe(keys);
		expect(resolveKey).toHaveBeenCalledTimes(2);
	});

	it("lets the failed callers share one answer", async () => {
		resolveKey.mockRejectedValueOnce(new Error("offline"));

		const answers = await Promise.all([
			access(VAULT_SPACE),
			access(VAULT_SPACE),
		]);

		expect(answers).toEqual([null, null]);
		expect(resolveKey).toHaveBeenCalledOnce();
	});
});

describe("share keys", () => {
	it("keeps a share whose key cannot be read cold, without throwing", async () => {
		const shareAccess = createSpaceAccess({
			controller: { currentDevice: () => ({ id: "d1", name: "laptop" }) },
			settings,
			spaces: { get: () => ({ id: "s1", key: "not base64!" }) },
		} as unknown as Parameters<typeof createSpaceAccess>[0]);

		expect(await shareAccess({ id: "s1", root: "Team" })).toBeNull();
	});
});
