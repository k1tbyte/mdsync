import { createHash } from "node:crypto";
import { failure, fakeCloudflare } from "@tests/helpers/fake-cloudflare";
import { describe, expect, it } from "vitest";
import {
	ensureBucket,
	R2NotEnabledError,
	r2Storage,
	tokenTemplateUrl,
	verifyToken,
} from "@/cloudflare";

const BUCKETS = "/accounts/acc/r2/buckets";

describe("R2 storage", () => {
	it("creates the bucket, and takes one this account already owns", async () => {
		const created = fakeCloudflare([
			{
				method: "POST",
				path: BUCKETS,
				reply: () => ({ result: { name: "vault" } }),
			},
		]);
		await ensureBucket(created.api, "acc", "vault");
		expect(JSON.parse(created.calls[0]?.body as string)).toEqual({
			name: "vault",
		});

		const owned = fakeCloudflare([
			{ method: "POST", path: BUCKETS, reply: () => failure(10004, 409) },
		]);
		await expect(
			ensureBucket(owned.api, "acc", "vault"),
		).resolves.toBeUndefined();
	});

	it("tells an account without R2 apart from other failures", async () => {
		const off = fakeCloudflare([
			{ method: "POST", path: BUCKETS, reply: () => failure(10042, 403) },
		]);
		await expect(ensureBucket(off.api, "acc", "vault")).rejects.toBeInstanceOf(
			R2NotEnabledError,
		);

		const other = fakeCloudflare([
			{ method: "POST", path: BUCKETS, reply: () => failure(10005) },
		]);
		await expect(ensureBucket(other.api, "acc", "vault")).rejects.toThrow(
			/10005/,
		);
	});

	it("derives S3 credentials from the token: its id and the SHA-256 of its value", async () => {
		expect(await r2Storage("acc", "vault", "token-id", "token-value")).toEqual({
			endpoint: "https://acc.r2.cloudflarestorage.com",
			region: "auto",
			bucket: "vault",
			accessKeyId: "token-id",
			secretAccessKey: createHash("sha256").update("token-value").digest("hex"),
		});
	});
});

describe("verifyToken", () => {
	const ACCOUNT_VERIFY = "/accounts/acc/tokens/verify";
	const USER_VERIFY = "/user/tokens/verify";

	it("verifies an account token under its account", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: ACCOUNT_VERIFY,
				reply: () => ({ result: { id: "acct-token", status: "active" } }),
			},
		]);
		expect(await verifyToken(cf.api, "acc")).toBe("acct-token");
	});

	it("falls back to the user endpoint for a user token", async () => {
		const cf = fakeCloudflare([
			{ method: "GET", path: ACCOUNT_VERIFY, reply: () => failure(1000, 401) },
			{
				method: "GET",
				path: USER_VERIFY,
				reply: () => ({ result: { id: "user-token", status: "active" } }),
			},
		]);
		expect(await verifyToken(cf.api, "acc")).toBe("user-token");
	});

	it("refuses a token that is not active", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: ACCOUNT_VERIFY,
				reply: () => ({ result: { id: "t", status: "expired" } }),
			},
		]);
		await expect(verifyToken(cf.api, "acc")).rejects.toThrow(/expired/);
	});
});

describe("tokenTemplateUrl", () => {
	it("pre-fills an account token with the permissions the relay deploy and R2 setup need", () => {
		const url = new URL(tokenTemplateUrl());
		expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/");
		expect(url.searchParams.get("to")).toBe("/:account/api-tokens");
		expect(url.searchParams.get("name")).toBe("MDSync");
		expect(
			JSON.parse(url.searchParams.get("permissionGroupKeys") ?? ""),
		).toEqual([
			{ key: "workers_scripts", type: "edit" },
			{ key: "workers_kv_storage", type: "edit" },
			{ key: "workers_r2", type: "edit" },
			{ key: "account_settings", type: "read" },
		]);
	});
});
