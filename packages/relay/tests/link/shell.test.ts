import { newLinkId } from "@mdsync/protocol";
import { describe, expect, it } from "vitest";

import { handleShellRequest, type ShellEnv } from "../../src/link/shell";

const PAGE = "<!doctype html><title>viewer</title>";

function envWith(
	response: Response | null = new Response(PAGE, {
		headers: { "Content-Type": "text/html", ETag: '"v1"' },
	}),
) {
	const asked: string[] = [];
	const env = {
		ASSETS: {
			fetch: async (input: URL) => {
				asked.push(input.pathname);
				return response ?? new Response("nope", { status: 404 });
			},
		},
	} as unknown as ShellEnv;
	return { env, asked };
}

function get(path: string, env: ShellEnv, method = "GET") {
	const url = new URL(`https://relay.example.com${path}`);
	return handleShellRequest(new Request(url, { method }), env, url);
}

describe("the link page", () => {
	it("serves the viewer under security headers", async () => {
		const { env, asked } = envWith();
		const response = await get(`/s/${newLinkId()}`, env);
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe(PAGE);
		expect(asked).toEqual(["/viewer/"]);
		const csp = response?.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain("unsafe-eval");
		expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response?.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
		expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response?.headers.get("Content-Type")).toBe("text/html");
	});

	it("answers HEAD without a body", async () => {
		const response = await get(`/s/${newLinkId()}`, envWith().env, "HEAD");
		expect(response?.status).toBe(200);
		expect(await response?.text()).toBe("");
	});

	it("takes a trailing slash and leaves other paths alone", async () => {
		const { env } = envWith();
		expect((await get(`/s/${newLinkId()}/`, env))?.status).toBe(200);
		expect(await get("/share/sign", env)).toBeNull();
		expect(await get("/s", env)).toBeNull();
		expect(await get(`/s/${newLinkId()}/extra`, env)).toBeNull();
	});

	it("refuses an id that cannot be a link's, without touching the assets", async () => {
		const { env, asked } = envWith();
		expect((await get("/s/short", env))?.status).toBe(404);
		expect((await get("/s/..%2F..%2Fx", env))?.status).toBe(404);
		expect(asked).toEqual([]);
	});

	it("refuses other methods", async () => {
		const response = await get(`/s/${newLinkId()}`, envWith().env, "POST");
		expect(response?.status).toBe(405);
		expect(response?.headers.get("Allow")).toBe("GET, HEAD");
	});

	it("says so when the viewer was never deployed", async () => {
		const response = await get(
			`/s/${newLinkId()}`,
			envWith(new Response("", { status: 404 })).env,
		);
		expect(response?.status).toBe(503);
	});
});
