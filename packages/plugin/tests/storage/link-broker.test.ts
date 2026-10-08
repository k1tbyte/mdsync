import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLink,
	linkStatus,
	type NewLink,
	replaceLink,
	revokeLink,
} from "@/storage/adapters/link-broker";
import { StorageHttpError } from "@/storage/adapters/util";
import { StorageRequestError } from "@/storage/types";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
	throw: boolean;
}

interface Reply {
	status: number;
	text?: string;
}

const requests: Recorded[] = [];
let replies: (Reply | Error)[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = replies.shift() ?? { status: 200 };
		if (reply instanceof Error) return Promise.reject(reply);
		const text = reply.text ?? "";
		return Promise.resolve({
			status: reply.status,
			text,
			arrayBuffer: new ArrayBuffer(0),
			json: text.startsWith("{") ? JSON.parse(text) : {},
			headers: {},
		});
	},
}));

const admin = { relayUrl: "https://relay.example", secret: "secret" };
const ID = "abcdefghijklmnopqrstuv";
const URL = `https://relay.example/link/${ID}`;
const sealed = new Uint8Array([1, 2, 3]);
const options: NewLink = {
	maxViews: null,
	ttl: null,
	gate: "G".repeat(43),
	salt: null,
};
const actions = {
	put: () => createLink(admin, ID, sealed, options),
	status: () => linkStatus(admin, ID),
	revoke: () => revokeLink(admin, ID),
};

beforeEach(() => {
	requests.length = 0;
	replies = [];
});

describe("the relay's share links", () => {
	it("creates with limits, expiry, protection and only the sealed bytes", async () => {
		const bytes = new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4);

		replies = [{ status: 200, text: '{"stored":true,"expires":2000000000}' }];
		expect(
			await createLink(admin, ID, bytes, {
				maxViews: 5,
				ttl: 3600,
				gate: "gate",
				salt: "salt",
			}),
		).toBe(2_000_000_000);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: `${URL}?maxViews=5&ttl=3600`,
			method: "PUT",
			headers: {
				"X-Mdsync-Admin": "secret",
				"Content-Type": "application/octet-stream",
				"X-Mdsync-Gate": "gate",
				"X-Mdsync-Salt": "salt",
			},
			throw: false,
		});
		expect(requests[0]?.body).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(requests[0]?.body as ArrayBuffer)).toEqual(sealed);
	});

	it("accepts an explicit null expiry and omits limits and salt, but sends its gate", async () => {
		replies = [{ status: 200, text: '{"expires":null}' }];
		expect(await actions.put()).toBeNull();
		expect(requests).toHaveLength(1);

		expect(requests[0]).toMatchObject({
			url: URL,
			method: "PUT",
		});
		expect(requests[0]?.headers).toEqual({
			"X-Mdsync-Admin": "secret",
			"Content-Type": "application/octet-stream",
			"X-Mdsync-Gate": options.gate,
		});
	});

	it("replaces a standing link using only its gate", async () => {
		await replaceLink(admin, ID, sealed, options.gate);

		expect(requests[0]).toMatchObject({
			url: `${URL}?update=1`,
			headers: { "X-Mdsync-Gate": options.gate },
			method: "PUT",
		});
		expect(new Uint8Array(requests[0]?.body as ArrayBuffer)).toEqual(sealed);
	});

	it("updates without limits using only the update query", async () => {
		await replaceLink(admin, ID, sealed, options.gate);
		expect(requests[0]?.headers).not.toHaveProperty("X-Mdsync-Salt");

		expect(requests[0]?.url).toBe(`${URL}?update=1`);
	});

	it.each([false, true])(
		"parses status with protection %s",
		async (protectedLink) => {
			const status = {
				views: 2,
				maxViews: protectedLink ? 5 : null,
				expires: protectedLink ? 2_000_000_000 : null,
				protected: protectedLink,
				size: 123,
			};
			replies = [{ status: 200, text: JSON.stringify(status) }];

			expect(await actions.status()).toEqual(status);
			expect(requests[0]).toMatchObject({
				url: `${URL}/status`,
				method: "GET",
				headers: { "X-Mdsync-Admin": "secret" },
				body: undefined,
				throw: false,
			});
		},
	);

	it("returns null when status says the link is gone", async () => {
		replies = [{ status: 404, text: '{"error":"gone"}' }];

		expect(await actions.status()).toBeNull();
	});

	it.each(["put", "status", "revoke"] as const)(
		"asks to redeploy an older relay on %s",
		async (action) => {
			for (const text of ["Not Found", '{"error":"not_found"}']) {
				replies = [{ status: 404, text }];
				const refused = actions[action]();

				await expect(refused).rejects.toBeInstanceOf(StorageRequestError);
				await expect(refused).rejects.toMatchObject({
					userMessage:
						"This relay is out of date for share links. Redeploy it with the Deploy Relay workflow.",
				});
			}
		},
	);

	it("revokes a creation without an expires key and refuses the older relay", async () => {
		replies = [{ status: 200, text: '{"stored":true}' }];
		const refused = createLink(admin, ID, sealed, { ...options, ttl: 3600 });
		await expect(refused).rejects.toBeInstanceOf(StorageRequestError);
		await expect(refused).rejects.toMatchObject({
			userMessage:
				"This relay is out of date for share links. Redeploy it with the Deploy Relay workflow.",
		});
		expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
			{ method: "PUT", url: `${URL}?ttl=3600` },
			{ method: "DELETE", url: URL },
		]);
	});

	it("revokes with an idempotent DELETE", async () => {
		replies = [
			{ status: 200, text: '{"revoked":true}' },
			{ status: 200, text: '{"revoked":true}' },
		];

		await actions.revoke();
		await actions.revoke();

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request).toMatchObject({
				url: URL,
				method: "DELETE",
				headers: { "X-Mdsync-Admin": "secret" },
				body: undefined,
				throw: false,
			});
		}
	});

	it.each(["put", "status", "revoke"] as const)(
		"names a refused admin secret on %s",
		async (action) => {
			replies = [{ status: 401, text: '{"error":"unauthorized"}' }];

			await expect(actions[action]()).rejects.toMatchObject({
				userMessage:
					"The relay did not accept its secret. Check the relay settings.",
			});
		},
	);

	it("explains an oversized note", async () => {
		replies = [{ status: 413, text: '{"error":"too_large"}' }];

		await expect(actions.put()).rejects.toMatchObject({
			userMessage: "This note is too large to share as a link.",
		});
	});

	it("explains a mismatched gate on replacement", async () => {
		replies = [{ status: 403, text: '{"error":"gate"}' }];
		await expect(
			replaceLink(admin, ID, sealed, options.gate),
		).rejects.toMatchObject({
			userMessage: "That is not this link's passphrase.",
		});
	});

	it("asks for a new link when an update has ended", async () => {
		replies = [{ status: 404, text: '{"error":"gone"}' }];

		await expect(
			replaceLink(admin, ID, sealed, options.gate),
		).rejects.toMatchObject({
			userMessage: "This link has ended. Create a new one.",
		});
	});

	it.each([409, 500])("keeps HTTP %s as an HTTP error", async (status) => {
		replies = [{ status, text: '{"error":"exists"}' }];
		const refused = actions.put();

		await expect(refused).rejects.toBeInstanceOf(StorageHttpError);
		await expect(refused).rejects.toMatchObject({ status });
	});

	it("propagates a network failure unchanged", async () => {
		const failure = new Error("Network failure");
		replies = [failure];

		await expect(actions.put()).rejects.toBe(failure);
	});

	it("strips the relay URL's trailing slash", async () => {
		replies = [{ status: 200, text: '{"expires":null}' }];
		await createLink(
			{ ...admin, relayUrl: `${admin.relayUrl}/` },
			ID,
			sealed,
			options,
		);

		expect(requests[0]?.url).toBe(URL);
	});
});
