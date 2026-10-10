import { beforeEach, describe, expect, it, vi } from "vitest";

import { testRelay } from "@/settings/connection-test";

interface Reply {
	status: number;
	json?: () => unknown;
	error?: Error;
}

const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
let reply: Reply = { status: 200 };

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: { url: string; headers?: Record<string, string> }) => {
		requests.push(params);
		if (reply.error) return Promise.reject(reply.error);
		const { status, json } = reply;
		return Promise.resolve({
			status,
			get json() {
				return json?.();
			},
		});
	},
}));

const RELAY = { relayUrl: "https://relay.example/", relaySecret: "s3cret" };

beforeEach(() => {
	requests.length = 0;
	reply = { status: 200 };
});

describe("testRelay", () => {
	it("asks the relay's status with the admin secret", async () => {
		await testRelay(RELAY);

		expect(requests).toEqual([
			expect.objectContaining({
				url: "https://relay.example/status",
				headers: { "X-Mdsync-Admin": "s3cret" },
			}),
		]);
	});

	it("returns the version the relay reports", async () => {
		reply = { status: 200, json: () => ({ version: "v-hash" }) };

		expect(await testRelay(RELAY)).toEqual({
			ok: true,
			message: "Connected. The relay accepts this secret.",
			version: "v-hash",
		});
	});

	it("returns a null version for a relay that reports none", async () => {
		reply = { status: 200, json: () => ({}) };

		const result = await testRelay(RELAY);

		expect(result.ok).toBe(true);
		expect(result.version).toBeNull();
	});

	it("fails with the relay's message on a non-200 answer", async () => {
		reply = { status: 401, json: () => ({ message: "Wrong secret" }) };

		expect(await testRelay(RELAY)).toEqual({
			ok: false,
			message: "Relay error: Wrong secret",
		});
	});

	it("fails with the HTTP status when an HTML error page has no JSON", async () => {
		reply = {
			status: 404,
			json: () => {
				throw new SyntaxError("Unexpected token '<'");
			},
		};

		expect(await testRelay(RELAY)).toEqual({
			ok: false,
			message: "Relay error: HTTP 404",
		});
	});

	it("still connects when a 200 body is not JSON", async () => {
		reply = {
			status: 200,
			json: () => {
				throw new SyntaxError("Unexpected token '<'");
			},
		};

		const result = await testRelay(RELAY);

		expect(result.ok).toBe(true);
		expect(result.version).toBeNull();
	});

	it("fails with the network error when the relay is unreachable", async () => {
		reply = { status: 0, error: new Error("net::ERR_NAME_NOT_RESOLVED") };

		const result = await testRelay(RELAY);

		expect(result.ok).toBe(false);
		expect(result.message).toContain("ERR_NAME_NOT_RESOLVED");
	});

	it("asks for both URL and secret before reaching out", async () => {
		const result = await testRelay({
			relayUrl: RELAY.relayUrl,
			relaySecret: "",
		});

		expect(result.ok).toBe(false);
		expect(requests).toEqual([]);
	});
});
