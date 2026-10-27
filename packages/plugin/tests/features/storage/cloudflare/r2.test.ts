import { createHash } from "node:crypto";
import { failure, fakeCloudflare } from "@tests/helpers/fake-cloudflare";
import { describe, expect, it } from "vitest";
import {
	ensureBucket,
	R2NotEnabledError,
	r2AccountOf,
	r2Keys,
	r2Storage,
} from "@/features/storage/cloudflare/r2";

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

describe("r2AccountOf", () => {
	it.each([
		["https://abc123.r2.cloudflarestorage.com", "abc123"],
		["https://abc123.eu.r2.cloudflarestorage.com", "abc123"],
		["https://abc123.r2.cloudflarestorage.com/", "abc123"],
	])("reads the account out of %s", (endpoint, account) => {
		expect(r2AccountOf(endpoint)).toBe(account);
	});

	it.each([
		"https://s3.amazonaws.com",
		"https://minio.example:9000",
		"http://abc123.r2.cloudflarestorage.com",
		"",
	])("returns null for %j", (endpoint) => {
		expect(r2AccountOf(endpoint)).toBeNull();
	});
});

describe("r2Keys", () => {
	it("keeps the token's id and hashes its value", async () => {
		expect(await r2Keys("token-id", "token-value")).toEqual({
			accessKeyId: "token-id",
			secretAccessKey: createHash("sha256").update("token-value").digest("hex"),
		});
	});
});
