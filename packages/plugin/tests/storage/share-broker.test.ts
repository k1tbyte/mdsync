import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let serve: ((request: Recorded) => Reply) | null = null;

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = serve?.(params) ?? replies.shift() ?? { status: 200 };
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
	serve = null;
});

afterEach(() => {
	vi.useRealTimers();
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

	it("lists etags relative to the share", async () => {
		replies = [
			signed("https://s3.example/b?list", BASE),
			{
				status: 200,
				text: `<ListBucketResult><Contents><Key>${BASE}objects/a</Key><ETag>&quot;e1&quot;</ETag></Contents></ListBucketResult>`,
			},
		];

		expect(await broker().listWithEtags?.("objects/")).toEqual([
			{ key: "objects/a", etag: '"e1"' },
		]);
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

	it("names the share, not the relay, so a new link keeps the sync state", () => {
		const moved = createBrokerAdapter("s1", {
			relayUrl: "https://other.example",
			token: "new",
		});

		expect(moved.identity()).toBe(broker().identity());
	});
});

const SIGN_URL = "https://relay.example/share/sign";
const OBJECT = { status: 200, arrayBuffer: new Uint8Array([7]).buffer };
const keysOf = (count: number) =>
	Array.from({ length: count }, (_, index) => `objects/k${index}`);
const objectUrl = (key: string) => `https://s3.example/b/${BASE}${key}?sig`;
const signPosts = () =>
	requests
		.filter((request) => request.url === SIGN_URL)
		.map(
			(request) => JSON.parse(String(request.body)) as Record<string, unknown>,
		);
const objectGets = () =>
	requests.filter((request) => request.url !== SIGN_URL).map((r) => r.url);

function serveSigns(
	batch?: (keys: string[]) => Reply,
	object: (url: string) => Reply = () => OBJECT,
): void {
	serve = (request) => {
		if (request.url !== SIGN_URL) return object(request.url);
		const { key, keys } = JSON.parse(String(request.body)) as {
			key?: string;
			keys?: string[];
		};
		if (keys) {
			return (
				batch?.(keys) ?? {
					status: 200,
					text: JSON.stringify({ urls: keys.map(objectUrl), method: "GET" }),
				}
			);
		}
		return signed(objectUrl(String(key)));
	};
}

describe("reads hinted ahead through the share broker", () => {
	it("asks the broker for nothing when the hint is given", () => {
		serveSigns();

		broker().prepareReads?.(keysOf(64));

		expect(requests).toHaveLength(0);
	});

	it("signs 64 hinted reads with two batch requests and no single sign", async () => {
		serveSigns();
		const keys = keysOf(64);
		const storage = broker();
		storage.prepareReads?.(keys);

		await Promise.all(keys.map((key) => storage.get(key)));

		expect(signPosts()).toEqual([
			{ op: "get", keys: keys.slice(0, 32) },
			{ op: "get", keys: keys.slice(32) },
		]);
		expect(objectGets().sort()).toEqual(keys.map(objectUrl).sort());
	});

	it("has four parallel reads start one batch, not four", async () => {
		serveSigns();
		const keys = keysOf(4);
		const storage = broker();
		storage.prepareReads?.(keys);

		await Promise.all(keys.map((key) => storage.get(key)));

		expect(signPosts()).toEqual([{ op: "get", keys }]);
	});

	it("signs a key nobody hinted on its own", async () => {
		serveSigns();
		const storage = broker();
		storage.prepareReads?.(["objects/a"]);

		await storage.get("objects/b");

		expect(signPosts()).toEqual([{ op: "get", key: "objects/b" }]);
	});

	it("drops the keys of an earlier hint", async () => {
		serveSigns();
		const storage = broker();
		storage.prepareReads?.(["objects/a"]);
		storage.prepareReads?.(["objects/b"]);

		await storage.get("objects/a");
		await storage.get("objects/b");

		expect(signPosts()).toEqual([
			{ op: "get", key: "objects/a" },
			{ op: "get", keys: ["objects/b"] },
		]);
	});

	it("signs alone again when a read is retried", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		serveSigns(undefined, () => (++attempts === 1 ? { status: 503 } : OBJECT));
		const storage = broker();
		storage.prepareReads?.(keysOf(2));

		const read = storage.get("objects/k0");
		await vi.advanceTimersByTimeAsync(1_000);

		expect(await read).toEqual(new Uint8Array([7]));
		expect(signPosts()).toEqual([
			{ op: "get", keys: keysOf(2) },
			{ op: "get", key: "objects/k0" },
		]);
	});

	it("signs alone when a prepared URL is too old, and batches the next ones afresh", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		serveSigns();
		const keys = keysOf(64);
		const storage = broker();
		storage.prepareReads?.(keys);
		await storage.get(keys[0] as string);

		vi.advanceTimersByTime(61_000);
		await storage.get(keys[1] as string);
		await storage.get(keys[32] as string);

		expect(signPosts()).toEqual([
			{ op: "get", keys: keys.slice(0, 32) },
			{ op: "get", key: keys[1] },
			{ op: "get", keys: keys.slice(32) },
		]);
	});

	it("falls back to single signs when the batch fails", async () => {
		serveSigns(() => ({ status: 500 }));
		const keys = keysOf(2);
		const storage = broker();
		storage.prepareReads?.(keys);

		await Promise.all(keys.map((key) => storage.get(key)));

		expect(signPosts()).toEqual([
			{ op: "get", keys },
			{ op: "get", key: keys[0] },
			{ op: "get", key: keys[1] },
		]);
	});

	it("treats a batch answer of the wrong length as failed", async () => {
		serveSigns((keys) => ({
			status: 200,
			text: JSON.stringify({ urls: keys.slice(1).map(objectUrl) }),
		}));
		const keys = keysOf(2);
		const storage = broker();
		storage.prepareReads?.(keys);

		await Promise.all(keys.map((key) => storage.get(key)));

		expect(signPosts()).toEqual([
			{ op: "get", keys },
			{ op: "get", key: keys[0] },
			{ op: "get", key: keys[1] },
		]);
		expect(objectGets().sort()).toEqual(keys.map(objectUrl).sort());
	});

	it("still surfaces a refused token from the single sign", async () => {
		serve = (request) =>
			request.url === SIGN_URL
				? { status: 401, text: '{"error":"unauthorized"}' }
				: OBJECT;
		const storage = broker();
		storage.prepareReads?.(["objects/a"]);

		await expect(storage.get("objects/a")).rejects.toMatchObject({
			userMessage: "This shared folder's invite is no longer valid.",
		});
		expect(signPosts()).toEqual([
			{ op: "get", keys: ["objects/a"] },
			{ op: "get", key: "objects/a" },
		]);
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
