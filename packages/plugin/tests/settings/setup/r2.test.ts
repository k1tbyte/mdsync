import { createHash } from "node:crypto";
import {
	failure,
	fakeCloudflare,
	type Reply,
} from "@tests/helpers/fake-cloudflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import { R2NotEnabledError } from "@/cloudflare";
import type { PluginHost } from "@/plugin/host";
import * as cloudflare from "@/settings/cloudflare-login";
import { mergeSettings } from "@/settings/model";
import { useR2, vaultPrefix } from "@/settings/setup/r2";
import { defaultS3Config, EStorageBackend } from "@/storage";

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
