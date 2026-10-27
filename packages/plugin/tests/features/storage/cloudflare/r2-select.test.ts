import { createHash } from "node:crypto";
import {
	failure,
	fakeCloudflare,
	type Reply,
} from "@tests/helpers/fake-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { mergeSettings } from "@/app/settings";
import * as cloudflareModule from "@/core/cloudflare";
import { defaultS3Config } from "@/features/storage/backends/s3";
import { StorageHttpError } from "@/features/storage/backends/util";
import * as cloudflare from "@/features/storage/cloudflare/cloudflare-login";
import { R2NotEnabledError } from "@/features/storage/cloudflare/r2";
import {
	rekeyR2,
	useR2,
	vaultPrefix,
} from "@/features/storage/cloudflare/r2-select";
import { EStorageBackend } from "@/features/storage/config";
import * as storage from "@/features/storage/registry";

const BUCKETS = "/accounts/acc/r2/buckets";
const VERIFY = "/accounts/acc/tokens/verify";

function host(name = "My Notes"): PluginHost {
	return {
		settings: mergeSettings({
			cloudflareToken: "token-value",
			cloudflareAccountId: "acc",
			activeStorageKind: EStorageBackend.WebDAV,
			storageConfigs: {
				[EStorageBackend.WebDAV]: {
					kind: EStorageBackend.WebDAV,
					baseUrl: "https://webdav.example",
					basePath: "notes",
					username: "user",
					password: "password",
					concurrency: 4,
				},
				[EStorageBackend.S3]: {
					...defaultS3Config(),
					bucket: "old-bucket",
					prefix: "old-prefix",
					accessKeyId: "old-key",
					secretAccessKey: "old-secret",
				},
			},
		}),
		app: { vault: { getName: vi.fn(() => name) } },
		saveSettings: vi.fn(async () => {}),
		scheduleScopeRefresh: vi.fn(),
	} as unknown as PluginHost;
}

function connected(
	bucket: () => Reply = () => ({ result: { name: "mdsync-vaults" } }),
	verify: () => Reply = () => ({
		result: { id: "token-id", status: "active" },
	}),
) {
	const cf = fakeCloudflare(
		[
			{ method: "POST", path: BUCKETS, reply: bucket },
			{ method: "GET", path: VERIFY, reply: verify },
		],
		"token-value",
	);
	vi.spyOn(cloudflare, "cloudflareOf").mockReturnValue({
		api: cf.api,
		accountId: "acc",
	});
	return cf;
}

afterEach(() => {
	vi.restoreAllMocks();
});

function hash8(name: string): string {
	return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

describe("vaultPrefix", () => {
	it.each([
		["My Notes", "my-notes"],
		["  Work___Notes!!  ", "work-notes"],
		["A...B / C", "a-b-c"],
		["2026", "2026"],
		["笔记 42", "42"],
		["Café", "caf"],
	])("uses the Latin letters and digits in %s as %s", async (name, slug) => {
		expect(await vaultPrefix(name)).toBe(`${slug}-${hash8(name)}`);
	});

	it.each(["笔记", "日本語", "📚", "---", "", "   "])(
		"falls back to vault when %j has no Latin letters or digits",
		async (name) => {
			expect(await vaultPrefix(name)).toBe(`vault-${hash8(name)}`);
		},
	);

	it("keeps names the slug folds together apart, and each one stable", async () => {
		const first = await vaultPrefix("Work Notes");
		expect(await vaultPrefix("Work Notes")).toBe(first);
		expect(await vaultPrefix("Work-Notes")).not.toBe(first);
		expect(await vaultPrefix("日本語")).not.toBe(await vaultPrefix("笔记"));
	});
});

describe("useR2", () => {
	it("creates the shared bucket and saves vault-specific S3 credentials before refreshing scope", async () => {
		const plugin = host();
		const previousWebDAV =
			plugin.settings.storageConfigs[EStorageBackend.WebDAV];
		const cf = connected();
		const expected = {
			...defaultS3Config(),
			endpoint: "https://acc.r2.cloudflarestorage.com",
			region: "auto",
			bucket: "mdsync-vaults",
			accessKeyId: "token-id",
			secretAccessKey: createHash("sha256").update("token-value").digest("hex"),
			prefix: `my-notes-${hash8("My Notes")}`,
		};
		vi.mocked(plugin.saveSettings).mockImplementation(async () => {
			expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toEqual(
				expected,
			);
			expect(plugin.settings.activeStorageKind).toBe(EStorageBackend.S3);
			expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
		});

		await useR2(plugin);

		expect(cloudflare.cloudflareOf).toHaveBeenCalledWith(plugin.settings);
		expect(cf.paths()).toEqual([`POST ${BUCKETS}`, `GET ${VERIFY}`]);
		expect(JSON.parse(cf.calls[0]?.body as string)).toEqual({
			name: "mdsync-vaults",
		});
		expect(cf.calls.map((call) => call.headers.Authorization)).toEqual([
			"Bearer token-value",
			"Bearer token-value",
		]);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toEqual(
			expected,
		);
		expect(plugin.settings.storageConfigs[EStorageBackend.WebDAV]).toBe(
			previousWebDAV,
		);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.scheduleScopeRefresh).toHaveBeenCalledTimes(1);
		expect(plugin.scheduleScopeRefresh).toHaveBeenCalledWith(
			"Storage backend changed.",
		);
	});

	it("uses an already-owned bucket and a hashed prefix for a non-Latin vault", async () => {
		const plugin = host("笔记");
		connected(() => failure(10004, 409));
		await useR2(plugin);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			bucket: "mdsync-vaults",
			prefix: `vault-${hash8("笔记")}`,
		});
		expect(plugin.settings.activeStorageKind).toBe(EStorageBackend.S3);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ cloudflareToken: "", cloudflareAccountId: "acc" },
		{ cloudflareToken: "token-value", cloudflareAccountId: "" },
		{ cloudflareToken: "", cloudflareAccountId: "" },
	])("requires both Cloudflare login fields: %j", async (login) => {
		const plugin = host();
		Object.assign(plugin.settings, login);
		const before = structuredClone(plugin.settings);
		await expect(useR2(plugin)).rejects.toThrow(
			"Connect your Cloudflare account first.",
		);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("leaves storage unchanged when R2 is not enabled", async () => {
		const plugin = host();
		const before = structuredClone(plugin.settings);
		const cf = connected(() => failure(10042, 403));
		await expect(useR2(plugin)).rejects.toBeInstanceOf(R2NotEnabledError);
		expect(cf.paths()).toEqual([`POST ${BUCKETS}`]);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("leaves storage unchanged when bucket creation fails", async () => {
		const plugin = host();
		const before = structuredClone(plugin.settings);
		const cf = connected(() => failure(10005));
		await expect(useR2(plugin)).rejects.toThrow(/10005/);
		expect(cf.paths()).toEqual([`POST ${BUCKETS}`]);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("leaves storage unchanged when the token is expired", async () => {
		const plugin = host();
		const before = structuredClone(plugin.settings);
		const cf = connected(undefined, () => ({
			result: { id: "token-id", status: "expired" },
		}));
		await expect(useR2(plugin)).rejects.toThrow(
			"The Cloudflare token is expired.",
		);
		expect(cf.paths()).toEqual([`POST ${BUCKETS}`, `GET ${VERIFY}`]);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("leaves storage unchanged when token verification fails", async () => {
		const plugin = host();
		const before = structuredClone(plugin.settings);
		connected(undefined, () => failure(10005));
		await expect(useR2(plugin)).rejects.toThrow(/10005/);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("does not refresh scope when saving the new storage fails", async () => {
		const plugin = host();
		connected();
		vi.mocked(plugin.saveSettings).mockRejectedValueOnce(
			new Error("save failed"),
		);
		await expect(useR2(plugin)).rejects.toThrow("save failed");
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});
});

describe("useR2 prefix", () => {
	function withS3(
		plugin: PluginHost,
		endpoint: string,
		bucket: string,
		prefix = "kept-prefix",
	) {
		plugin.settings.storageConfigs[EStorageBackend.S3] = {
			...defaultS3Config(),
			endpoint,
			bucket,
			prefix,
			accessKeyId: "old-key",
			secretAccessKey: "old-secret",
		};
	}

	it("keeps the prefix of the same endpoint and bucket", async () => {
		const plugin = host();
		withS3(plugin, "https://acc.r2.cloudflarestorage.com", "mdsync-vaults");
		connected();
		await useR2(plugin);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			prefix: "kept-prefix",
			accessKeyId: "token-id",
		});
	});

	it("keeps a vault at the bucket root there", async () => {
		const plugin = host();
		withS3(plugin, "https://acc.r2.cloudflarestorage.com", "mdsync-vaults", "");
		connected();
		await useR2(plugin);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			prefix: "",
		});
	});

	it.each([
		["another bucket", "https://acc.r2.cloudflarestorage.com", "other-bucket"],
		[
			"another endpoint",
			"https://other.r2.cloudflarestorage.com",
			"mdsync-vaults",
		],
	])("derives a new prefix for %s", async (_, endpoint, bucket) => {
		const plugin = host();
		withS3(plugin, endpoint, bucket);
		connected();
		await useR2(plugin);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			prefix: `my-notes-${hash8("My Notes")}`,
		});
	});
});

describe("rekeyR2", () => {
	const ACCOUNT = "0123456789abcdef0123456789abcdef";
	const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
	const sha = (value: string) =>
		createHash("sha256").update(value).digest("hex");

	function r2host(savedToken = "old-token", storageToken = "old-token") {
		const plugin = host();
		plugin.settings.cloudflareToken = savedToken;
		plugin.settings.activeStorageKind = EStorageBackend.S3;
		plugin.settings.storageConfigs[EStorageBackend.S3] = {
			...defaultS3Config(),
			endpoint: ENDPOINT,
			region: "auto",
			bucket: "mdsync-vaults",
			prefix: "my-notes-1234abcd",
			accessKeyId: "old-id",
			secretAccessKey: sha(storageToken),
		};
		return plugin;
	}

	function probe(result: () => Promise<boolean>) {
		const exists = vi.fn(result);
		vi.spyOn(storage, "createStorageAdapter").mockReturnValue({
			exists,
		} as unknown as ReturnType<typeof storage.createStorageAdapter>);
		return exists;
	}

	function verifying() {
		const cf = fakeCloudflare(
			[
				{
					method: "GET",
					path: `/accounts/${ACCOUNT}/tokens/verify`,
					reply: () => ({ result: { id: "new-id", status: "active" } }),
				},
			],
			"new-token",
		);
		const spy = vi
			.spyOn(cloudflareModule, "cloudflareApi")
			.mockReturnValue(cf.api);
		return { cf, spy };
	}

	it("derives keys from a token value, probing the storage with them before saving", async () => {
		const plugin = r2host();
		const before = plugin.settings.storageConfigs[EStorageBackend.S3];
		const { cf, spy } = verifying();
		const exists = probe(async () => true);
		vi.mocked(plugin.saveSettings).mockImplementation(async () => {
			expect(exists).toHaveBeenCalledTimes(1);
			expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
		});

		await rekeyR2(plugin, "new-token");

		expect(spy).toHaveBeenCalledWith(expect.any(Function), "new-token");
		expect(cf.paths()).toEqual([`GET /accounts/${ACCOUNT}/tokens/verify`]);
		expect(storage.createStorageAdapter).toHaveBeenCalledWith(
			expect.objectContaining({
				accessKeyId: "new-id",
				secretAccessKey: sha("new-token"),
			}),
		);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toEqual({
			...before,
			accessKeyId: "new-id",
			secretAccessKey: sha("new-token"),
		});
		expect(plugin.settings.cloudflareToken).toBe("new-token");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.scheduleScopeRefresh).toHaveBeenCalledExactlyOnceWith(
			"Storage backend changed.",
		);
	});

	it("keeps the saved login when it was not the storage keys' token", async () => {
		const plugin = r2host("other-login", "old-token");
		verifying();
		probe(async () => true);
		await rekeyR2(plugin, "new-token");
		expect(plugin.settings.cloudflareToken).toBe("other-login");
	});

	it("takes a Secret Access Key as is, asking Cloudflare nothing", async () => {
		const plugin = r2host();
		const { cf, spy } = verifying();
		probe(async () => true);
		const secret = "ABCDEF0123456789".repeat(4);

		await rekeyR2(plugin, secret);

		expect(spy).not.toHaveBeenCalled();
		expect(cf.calls).toEqual([]);
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			accessKeyId: "old-id",
			secretAccessKey: secret.toLowerCase(),
		});
		expect(plugin.settings.cloudflareToken).toBe("old-token");
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.scheduleScopeRefresh).toHaveBeenCalledTimes(1);
	});

	it("saves nothing when R2 refuses the new keys too", async () => {
		const plugin = r2host();
		const before = structuredClone(plugin.settings);
		verifying();
		probe(() => Promise.reject(new StorageHttpError(401, "Unauthorized")));

		await expect(rekeyR2(plugin, "new-token")).rejects.toThrow(
			/R2 refuses these keys too/,
		);

		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.scheduleScopeRefresh).not.toHaveBeenCalled();
	});

	it("leaves storage edited during the check alone", async () => {
		const plugin = r2host();
		verifying();
		probe(async () => {
			plugin.settings.storageConfigs[EStorageBackend.S3] = {
				...defaultS3Config(),
				bucket: "picked-meanwhile",
			};
			return true;
		});

		await expect(rekeyR2(plugin, "new-token")).rejects.toThrow(
			"The storage settings changed meanwhile.",
		);

		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).toMatchObject({
			bucket: "picked-meanwhile",
			accessKeyId: "",
		});
		expect(plugin.settings.cloudflareToken).toBe("old-token");
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it("rejects a vault that is not kept in R2", async () => {
		const plugin = host();
		const before = structuredClone(plugin.settings);
		await expect(rekeyR2(plugin, "new-token")).rejects.toThrow(
			"This vault is not kept in R2.",
		);
		expect(plugin.settings).toEqual(before);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});
});
