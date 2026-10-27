import { failure, fakeCloudflare } from "@tests/helpers/fake-cloudflare";
import { describe, expect, it } from "vitest";
import { CloudflareError, isRefusedToken } from "@/core/cloudflare/api";
import { tokenTemplateUrl, verifyToken } from "@/core/cloudflare/token";

describe("isRefusedToken", () => {
	it.each([401, 403])("is true for a Cloudflare %i", (status) => {
		expect(isRefusedToken(new CloudflareError(status, [], "no"))).toBe(true);
	});

	it.each([new CloudflareError(409, [], "conflict"), new Error("401")])(
		"is false for %s",
		(err) => {
			expect(isRefusedToken(err)).toBe(false);
		},
	);
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
		const err: unknown = await verifyToken(cf.api, "acc").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toMatch(/expired/);
		expect(isRefusedToken(err)).toBe(true);
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
