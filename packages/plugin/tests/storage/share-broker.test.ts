import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBrokerAdapter,
	listParticipants,
	revokeParticipant,
} from "@/storage/adapters/share-broker";

interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

interface Reply {
	status: number;
	text?: string;
	arrayBuffer?: ArrayBuffer;
}

const requests: Recorded[] = [];
let replies: Reply[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = replies.shift() ?? { status: 200 };
		const text = reply.text ?? "";
		return Promise.resolve({
			status: reply.status,
			text,
			arrayBuffer: reply.arrayBuffer ?? new ArrayBuffer(0),
			json: text.startsWith("{") ? JSON.parse(text) : {},
			headers: {},
		});
	},
}));

const RELAY = "https://relay.example/";
const BASE = "vault/shares/s1/";
const broker = () =>
	createBrokerAdapter("s1", { relayUrl: RELAY, token: "tok" });
const signed = (url: string, base?: string): Reply => ({
	status: 200,
	text: JSON.stringify({ url, method: "GET", base }),
});
const listing = (keys: string[]): Reply => ({
	status: 200,
	text: `<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}</ListBucketResult>`,
});
const signBody = (index: number) =>
	JSON.parse(String(requests[index]?.body)) as Record<string, unknown>;

beforeEach(() => {
	requests.length = 0;
	replies = [];
});

describe("storage through the share broker", () => {
	it("has each request signed under the share token, then goes to the bucket", async () => {
		replies = [
			signed("https://s3.example/b/vault/shares/s1/manifest.json.enc?sig"),
			{ status: 200, arrayBuffer: new Uint8Array([7]).buffer },
		];

		expect(await broker().get("manifest.json.enc")).toEqual(
			new Uint8Array([7]),
		);
		expect(requests[0]).toMatchObject({
			url: "https://relay.example/share/sign",
			method: "POST",
			headers: { Authorization: "Bearer tok" },
		});
		expect(signBody(0)).toEqual({ op: "get", key: "manifest.json.enc" });
		expect(requests[1]?.url).toBe(
			"https://s3.example/b/vault/shares/s1/manifest.json.enc?sig",
		);
	});

	it("lists keys relative to the share", async () => {
		replies = [
			signed("https://s3.example/b?list", BASE),
			listing([`${BASE}objects/a`, `${BASE}objects/b`]),
		];

		expect(await broker().list("objects/")).toEqual(["objects/a", "objects/b"]);
		expect(signBody(0)).toEqual({ op: "list", prefix: "objects/" });
	});

	it("probes existence with a one-key listing", async () => {
		replies = [
			signed("https://s3.example/b?list", BASE),
			listing([`${BASE}objects/a`]),
		];

		expect(await broker().exists("objects/a")).toBe(true);
		expect(signBody(0)).toMatchObject({ maxKeys: 1, prefix: "objects/a" });
	});

	it("keeps a conditional write's precondition on the presigned request", async () => {
		replies = [signed("https://s3.example/b/k?sig"), { status: 412 }];

		expect(await broker().putIfAbsent("k", new Uint8Array([1]))).toBe(false);
		expect(signBody(0)).toEqual({ op: "put", key: "k" });
		expect(requests[1]?.headers["If-None-Match"]).toBe("*");
	});

	it("takes a refused token as final, not as a network hiccup", async () => {
		replies = [{ status: 401, text: '{"error":"unauthorized"}' }];

		await expect(broker().get("k")).rejects.toMatchObject({
			userMessage: "This shared folder's invite is no longer valid.",
		});
		expect(requests).toHaveLength(1);
	});
});

describe("the owner's view of a share's participants", () => {
	const admin = { relayUrl: RELAY, secret: "secret" };

	it("lists who holds access, by name and role", async () => {
		replies = [
			{
				status: 200,
				text: JSON.stringify({
					participants: [
						{ participantId: "p1", label: "Friend", role: "ro" },
						{ participantId: "p2", label: "Colleague", role: "rw" },
					],
				}),
			},
		];

		expect(await listParticipants(admin, "s1")).toEqual([
			{ id: "p1", label: "Friend", readOnly: true },
			{ id: "p2", label: "Colleague", readOnly: false },
		]);
		expect(requests[0]).toMatchObject({
			url: "https://relay.example/share/tokens?shareId=s1",
			method: "GET",
			headers: { "X-Obsync-Admin": "secret" },
			body: undefined,
		});
	});

	it("revokes one of them", async () => {
		await revokeParticipant(admin, "s1", "p 1");

		expect(requests[0]).toMatchObject({
			url: "https://relay.example/share/tokens/p%201?shareId=s1",
			method: "DELETE",
		});
	});
});
