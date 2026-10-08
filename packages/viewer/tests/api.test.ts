import { describe, expect, it } from "vitest";

import { createApi } from "../src/api";

const reply = (
	status: number,
	init: { body?: BodyInit; headers?: Record<string, string> } = {},
) =>
	(async () =>
		new Response(init.body ?? null, {
			status,
			headers: init.headers,
		})) as typeof fetch;

describe("meta", () => {
	it("reads whether a passphrase is asked for", async () => {
		const meta = { protected: true, salt: "abc" };
		const api = createApi(reply(200, { body: JSON.stringify(meta) }));
		expect(await api.meta("id")).toEqual(meta);
	});

	it("is null for a link that is gone and throws for a relay in trouble", async () => {
		expect(await createApi(reply(404)).meta("id")).toBeNull();
		await expect(createApi(reply(500)).meta("id")).rejects.toThrow("500");
	});
});

describe("open", () => {
	it("returns the bytes, the views left and the expiry", async () => {
		const api = createApi(
			reply(200, {
				body: Uint8Array.from([1, 2, 3]),
				headers: {
					"X-Mdsync-Views-Left": "2",
					"X-Mdsync-Expires": "1760003600",
				},
			}),
		);
		expect(await api.open("id", "G".repeat(43))).toEqual({
			kind: "opened",
			sealed: Uint8Array.from([1, 2, 3]),
			viewsLeft: 2,
			expires: 1_760_003_600,
		});
	});

	it("leaves the count out for an unlimited link", async () => {
		const api = createApi(reply(200, { body: Uint8Array.from([1]) }));
		expect(await api.open("id", "G".repeat(43))).toMatchObject({
			viewsLeft: null,
			expires: null,
		});
	});

	it.each(["", "0", "-1", "1.5", "later", "NaN", "Infinity", "1e309"])(
		"ignores an invalid expiry header %j",
		async (expires) => {
			const api = createApi(
				reply(200, { headers: { "X-Mdsync-Expires": expires } }),
			);
			expect(await api.open("id", "G".repeat(43))).toMatchObject({
				expires: null,
			});
		},
	);

	it("sends the gate in the body", async () => {
		let sent = "";
		const api = createApi((async (_url: string, init?: RequestInit) => {
			sent = String(init?.body);
			return new Response(null, { status: 404 });
		}) as typeof fetch);
		await api.open("id", "G".repeat(43));
		expect(JSON.parse(sent)).toEqual({ gate: "G".repeat(43) });
		await api.open("id", "U".repeat(43));
		expect(JSON.parse(sent)).toEqual({ gate: "U".repeat(43) });
	});

	it("tells gone, wrong gate and cooldown apart", async () => {
		expect(await createApi(reply(404)).open("id", "G".repeat(43))).toEqual({
			kind: "gone",
		});
		expect(await createApi(reply(401)).open("id", "g")).toEqual({
			kind: "gate",
			retryAfter: null,
		});
		expect(
			await createApi(reply(401, { headers: { "Retry-After": "60" } })).open(
				"id",
				"g",
			),
		).toEqual({
			kind: "gate",
			retryAfter: 60,
		});
		expect(
			await createApi(reply(429, { headers: { "Retry-After": "120" } })).open(
				"id",
				"g",
			),
		).toEqual({
			kind: "cooldown",
			retryAfter: 120,
		});
		expect(await createApi(reply(429)).open("id", "g")).toEqual({
			kind: "cooldown",
			retryAfter: 60,
		});
	});

	it("throws for any other answer", async () => {
		await expect(
			createApi(reply(502)).open("id", "G".repeat(43)),
		).rejects.toThrow("502");
	});
});
