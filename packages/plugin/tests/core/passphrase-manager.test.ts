import type { DataAdapter } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PassphraseManager } from "@/core/passphrase-manager";
import { saveCachedPassphrase } from "@/crypto/passphrase-cache";
import { DEFAULT_SETTINGS } from "@/settings/model";
import type { ObjectStorage } from "@/storage";
import { resolveContentKey } from "@/sync/keyfile";

vi.mock("@/sync/keyfile", () => ({
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
