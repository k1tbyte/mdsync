import { describe, expect, it } from "vitest";
import { cloudflareApi } from "@/cloudflare";
import { cloudflareErrorMessage } from "@/settings/cloudflare-login";

async function failureOf(code: number): Promise<unknown> {
	const api = cloudflareApi(
		async () => ({
			status: 403,
			text: JSON.stringify({
				success: false,
				errors: [{ code, message: `error ${code}` }],
			}),
		}),
		"tok",
	);
	return api.call("GET", "/x").catch((err: unknown) => err);
}

describe("cloudflareErrorMessage", () => {
	it("tells the person to recreate the token on an authentication error", async () => {
		expect(cloudflareErrorMessage(await failureOf(10000))).toContain(
			"Create it again",
		);
	});

	it("passes any other error through", async () => {
		expect(cloudflareErrorMessage(await failureOf(10004))).toContain(
			"error 10004",
		);
	});
});
