import { describe, expect, it } from "vitest";
import { cloudflareApi, hasCode } from "@/cloudflare";

function apiReplying(status: number, text: string) {
	return cloudflareApi(async () => ({ status, text }), "tok");
}

describe("cloudflareApi", () => {
	it("returns the result of a successful reply", async () => {
		const api = apiReplying(200, JSON.stringify({ success: true, result: 7 }));

		expect(await api.call("GET", "/x")).toBe(7);
	});

	it("throws the reply's errors with their codes", async () => {
		const api = apiReplying(
			400,
			JSON.stringify({
				success: false,
				errors: [{ code: 10004, message: "taken" }],
			}),
		);

		const err = await api.call("POST", "/x").catch((e: unknown) => e);

		expect(hasCode(err, 10004)).toBe(true);
		expect((err as Error).message).toContain("taken (10004)");
	});

	it("refuses a successful status whose body is not Cloudflare's JSON", async () => {
		const api = apiReplying(200, "<html>captive portal</html>");

		await expect(api.call("GET", "/x")).rejects.toThrow("HTTP 200");
	});

	it("sends the override bearer instead of the token", async () => {
		const sent: string[] = [];
		const api = cloudflareApi(async (request) => {
			sent.push(request.headers.Authorization ?? "");
			return { status: 200, text: JSON.stringify({ success: true }) };
		}, "tok");

		await api.call("GET", "/x", { bearer: "jwt" });

		expect(sent).toEqual(["Bearer jwt"]);
	});
});
