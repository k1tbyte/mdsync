import type { DataAdapter } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PassphraseManager } from "@/core/passphrase-manager";
import {
	loadCachedPassphrase,
	saveCachedPassphrase,
} from "@/crypto/passphrase-cache";
import { DEFAULT_SETTINGS, type MdsyncSettings } from "@/settings/model";
import { defaultS3Config, type ObjectStorage } from "@/storage";
import {
	type Keyfile,
	PassphraseRotatedError,
	readKeyfile,
	resolveContentKey,
} from "@/sync/keyfile";

vi.mock("@/sync/keyfile", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	readKeyfile: vi.fn(),
	resolveContentKey: vi.fn(),
	rotatePassphrase: vi.fn(),
}));
vi.mock("@/crypto/passphrase-cache", () => ({
	clearCachedPassphrase: vi.fn(async () => undefined),
	loadCachedPassphrase: vi.fn(async () => null),
	saveCachedPassphrase: vi.fn(async () => undefined),
}));

const STORAGE = {} as ObjectStorage;

function resolved(name: string) {
	return {
		contentKey: name,
		liveKeys: {},
		epoch: 1,
	} as unknown as Awaited<ReturnType<typeof resolveContentKey>>;
}

function manager(answers: string[]): PassphraseManager {
	const ask = vi.fn(async () => answers.shift() ?? null);
	return new PassphraseManager(ask, {} as DataAdapter, ".obsidian", {
		...DEFAULT_SETTINGS,
		cachePassphrase: true,
	});
}

function configured(bucket: string): MdsyncSettings {
	return {
		...DEFAULT_SETTINGS,
		cachePassphrase: true,
		storageConfigs: {
			s3: {
				...defaultS3Config(),
				endpoint: "https://s3.example.test",
				bucket,
				accessKeyId: "AK",
				secretAccessKey: "SK",
			},
		},
	};
}

function vaultManager(
	settings: MdsyncSettings,
	answers: string[] = [],
): PassphraseManager {
	return new PassphraseManager(
		async () => answers.shift() ?? null,
		{} as DataAdapter,
		".obsidian",
		settings,
	);
}

beforeEach(() => vi.clearAllMocks());

describe("PassphraseManager", () => {
	it("derives the key once for callers asking together", async () => {
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const passphrase = manager(["secret"]);
		await passphrase.prompt(false);

		await Promise.all([
			passphrase.resolveKey(STORAGE),
			passphrase.resolveKey(STORAGE),
		]);

		expect(resolveContentKey).toHaveBeenCalledOnce();
	});

	it("does not bring back a key forgotten while it was derived", async () => {
		let finish: (value: ReturnType<typeof resolved>) => void = () => {};
		vi.mocked(resolveContentKey).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const passphrase = manager(["secret"]);
		await passphrase.prompt(false);

		const key = passphrase.resolveKey(STORAGE);
		await passphrase.forget();
		finish(resolved("key"));
		await key;

		expect(passphrase.liveKeys()).toBeNull();
	});

	it("caches a typed passphrase only once it opened the keyfile", async () => {
		vi.mocked(resolveContentKey).mockRejectedValueOnce(new Error("wrong"));
		const passphrase = manager(["typo"]);
		await passphrase.prompt(true);

		await expect(passphrase.resolveKey(STORAGE)).rejects.toThrow("wrong");
		expect(saveCachedPassphrase).not.toHaveBeenCalled();

		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		await passphrase.resolveKey(STORAGE);
		expect(saveCachedPassphrase).toHaveBeenCalledOnce();
	});
});

describe("PassphraseManager.isUnlocked", () => {
	it("is locked before any key is resolved", async () => {
		const passphrase = vaultManager(configured("notes"), ["secret"]);
		await passphrase.prompt(false);

		expect(passphrase.isUnlocked()).toBe(false);
	});

	it("is unlocked once the current storage's key is open", async () => {
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const passphrase = vaultManager(configured("notes"));

		await passphrase.unlock("secret");

		expect(passphrase.isUnlocked()).toBe(true);
	});

	it("is not unlocked by a key opened for another storage", async () => {
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const settings = configured("notes");
		const passphrase = vaultManager(settings);
		await passphrase.unlock("secret");

		settings.storageConfigs = configured("other").storageConfigs;

		expect(passphrase.isUnlocked()).toBe(false);
	});
});

describe("PassphraseManager.vaultHasKey", () => {
	it("is true when the remote holds a keyfile", async () => {
		vi.mocked(readKeyfile).mockResolvedValue({ epoch: 1 } as Keyfile);

		expect(await vaultManager(configured("notes")).vaultHasKey()).toBe(true);
	});

	it("is false for a new vault without a keyfile", async () => {
		vi.mocked(readKeyfile).mockResolvedValue(null);

		expect(await vaultManager(configured("notes")).vaultHasKey()).toBe(false);
	});
});

describe("PassphraseManager.unlock", () => {
	it("opens the key with a given passphrase and caches it", async () => {
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const passphrase = vaultManager(configured("notes"));

		expect(await passphrase.unlock("secret")).toBe(true);

		expect(passphrase.current()).toBe("secret");
		expect(vi.mocked(resolveContentKey).mock.calls[0]?.[1]).toBe("secret");
		expect(saveCachedPassphrase).toHaveBeenCalledOnce();
	});

	it("restores the previous passphrase when the given one fails and rethrows", async () => {
		const passphrase = vaultManager(configured("notes"), ["old"]);
		await passphrase.prompt(false);
		vi.mocked(resolveContentKey).mockRejectedValueOnce(
			new PassphraseRotatedError(),
		);

		await expect(passphrase.unlock("new")).rejects.toBeInstanceOf(
			PassphraseRotatedError,
		);

		expect(passphrase.current()).toBe("old");
		expect(passphrase.isUnlocked()).toBe(false);
		expect(saveCachedPassphrase).not.toHaveBeenCalled();
	});

	it("keeps the restored passphrase unverified, so it is not cached until it opens the key", async () => {
		const passphrase = vaultManager(configured("notes"), ["old"]);
		await passphrase.prompt(false);
		vi.mocked(resolveContentKey).mockRejectedValueOnce(new Error("wrong"));
		await expect(passphrase.unlock("new")).rejects.toThrow("wrong");

		await passphrase.persistIfEnabled();

		expect(saveCachedPassphrase).not.toHaveBeenCalled();
	});

	it("leaves no passphrase behind when the first one fails", async () => {
		vi.mocked(resolveContentKey).mockRejectedValueOnce(new Error("wrong"));
		const passphrase = vaultManager(configured("notes"));

		await expect(passphrase.unlock("typo")).rejects.toThrow("wrong");

		expect(passphrase.has()).toBe(false);
	});

	it("uses the saved passphrase when none is given", async () => {
		vi.mocked(loadCachedPassphrase).mockResolvedValueOnce("saved");
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const passphrase = vaultManager(configured("notes"));

		expect(await passphrase.unlock()).toBe(true);

		expect(passphrase.current()).toBe("saved");
		expect(passphrase.isUnlocked()).toBe(true);
	});

	it("uses the entered passphrase when none is given", async () => {
		vi.mocked(resolveContentKey).mockResolvedValue(resolved("key"));
		const passphrase = vaultManager(configured("notes"), ["typed"]);
		await passphrase.prompt(false);
		vi.mocked(loadCachedPassphrase).mockClear();

		expect(await passphrase.unlock()).toBe(true);

		expect(vi.mocked(resolveContentKey).mock.calls[0]?.[1]).toBe("typed");
		expect(loadCachedPassphrase).not.toHaveBeenCalled();
	});

	it("returns false without a passphrase to try", async () => {
		const passphrase = vaultManager(configured("notes"));

		expect(await passphrase.unlock()).toBe(false);

		expect(resolveContentKey).not.toHaveBeenCalled();
	});
});
