import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleDriveAdapter } from "@/features/storage/backends/google-drive";
import { isRefusedCredentials } from "@/features/storage/backends/util";
import { EStorageBackend } from "@/features/storage/config";

const requests: { url: string; method?: string }[] = [];
let replies: unknown[] = [];
const STATUS = Symbol("status");

/** A reply other than 200, with Drive's JSON error body. */
const failed = (status: number, json: unknown = {}) => ({
	[STATUS]: status,
	json,
});

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: { url: string; method?: string }) => {
		requests.push(params);
		const reply = (replies.shift() ?? {}) as {
			[STATUS]?: number;
			json?: unknown;
		};
		const status = reply[STATUS];
		return Promise.resolve({
			status: status ?? 200,
			json: status === undefined ? reply : reply.json,
			text: status === undefined ? "" : JSON.stringify(reply.json),
			arrayBuffer: new ArrayBuffer(0),
			headers: {},
		});
	},
}));

const adapter = () =>
	createGoogleDriveAdapter({
		kind: EStorageBackend.GoogleDrive,
		folderName: "mdsync",
		authServerUrl: "https://auth.example",
		accessToken: "t",
		refreshToken: "",
		expiresAt: 0,
		concurrency: 4,
	});

const FOLDER = { files: [{ id: "F" }] };

beforeEach(() => {
	requests.length = 0;
	replies = [];
});

describe("Google Drive listings", () => {
	it("reports the md5 checksum as the etag and the last write, none for a file without them, across pages", async () => {
		replies = [
			FOLDER,
			{
				files: [
					{
						id: "1",
						name: "spaces/a.json.enc",
						md5Checksum: "aa",
						modifiedTime: "2026-09-30T10:00:00.000Z",
					},
					{ id: "2", name: "objects/x", md5Checksum: "xx" },
				],
				nextPageToken: "P2",
			},
			{ files: [{ id: "3", name: "spaces/b.json.enc" }] },
		];

		expect(await adapter().listDetailed?.("spaces/")).toEqual([
			{
				key: "spaces/a.json.enc",
				etag: "aa",
				modified: Date.UTC(2026, 8, 30, 10),
			},
			{ key: "spaces/b.json.enc", etag: null, modified: null },
		]);
		expect(decodeURIComponent(requests[1]?.url ?? "")).toContain(
			"files(id,name,md5Checksum,modifiedTime)",
		);
		expect(requests[2]?.url).toContain("pageToken=P2");
		for (const request of requests.slice(1)) {
			expect(new URL(request.url).searchParams.get("q")).toContain(
				"name contains 'spaces/'",
			);
		}
	});

	it("escapes a prefix in the server query", async () => {
		replies = [FOLDER, { files: [] }];
		await adapter().list("spaces/a'\\b");
		expect(new URL(requests[1]?.url ?? "").searchParams.get("q")).toContain(
			"name contains 'spaces/a\\'\\\\b'",
		);
	});

	it("omits the name filter for an empty prefix", async () => {
		replies = [FOLDER, { files: [{ id: "1", name: "objects/a" }] }];
		expect(await adapter().list("")).toEqual(["objects/a"]);
		expect(new URL(requests[1]?.url ?? "").searchParams.get("q")).not.toContain(
			"name contains",
		);
	});

	it("lists keys alone", async () => {
		replies = [
			FOLDER,
			{ files: [{ id: "1", name: "spaces/a.json.enc", md5Checksum: "aa" }] },
		];

		expect(await adapter().list("spaces/")).toEqual(["spaces/a.json.enc"]);
	});
});

describe("Google Drive bulk read IDs", () => {
	it("lazily resolves object IDs without relying on the spaces listing", async () => {
		const drive = adapter();
		const keys = Array.from({ length: 256 }, (_, index) => `objects/${index}`);
		drive.prepareReads?.(keys);
		expect(requests).toEqual([]);
		replies = [
			FOLDER,
			{ files: keys.map((name, index) => ({ id: String(index), name })) },
			{},
			{},
		];
		await Promise.all([drive.get("objects/1"), drive.get("objects/2")]);
		const searches = requests.filter(({ url }) =>
			new URL(url).searchParams.has("q"),
		);
		expect(searches).toHaveLength(2);
		expect(new URL(searches[1]?.url ?? "").searchParams.get("q")).toContain(
			"name contains 'objects/'",
		);
		expect(requests.some(({ url }) => url.includes("/1?alt=media"))).toBe(true);
		expect(requests.some(({ url }) => url.includes("/2?alt=media"))).toBe(true);
	});
});

describe("Google Drive conditional reads", () => {
	const bodyOf = (url: string) => url.includes("alt=media");

	it("answers unchanged from the checksum alone, without downloading", async () => {
		replies = [FOLDER, { files: [{ id: "7" }] }, { md5Checksum: "aa" }];

		expect(await adapter().getIfChanged?.("head", "aa")).toEqual({
			status: "unchanged",
		});
		expect(requests.some(({ url }) => bodyOf(url))).toBe(false);
	});

	it("downloads and returns the new checksum when it differs", async () => {
		const head = { md5Checksum: "bb", headRevisionId: "r2" };
		replies = [FOLDER, { files: [{ id: "7" }] }, head, {}, head];

		const read = await adapter().getIfChanged?.("head", "aa");

		expect(read).toMatchObject({ status: "found", etag: "bb" });
		expect(requests.some(({ url }) => url.includes("/7?alt=media"))).toBe(true);
	});

	it("binds no checksum to bytes a write replaced during the download", async () => {
		replies = [
			FOLDER,
			{ files: [{ id: "7" }] },
			{ md5Checksum: "bb", headRevisionId: "r2" },
			{},
			{ md5Checksum: "bb", headRevisionId: "r3" },
		];

		expect(await adapter().getIfChanged?.("head", "aa")).toMatchObject({
			status: "found",
			etag: null,
		});
	});

	it("never answers unchanged without a checksum", async () => {
		replies = [FOLDER, { files: [{ id: "7" }] }, {}, {}];

		expect(await adapter().getIfChanged?.("head", null)).toMatchObject({
			status: "found",
			etag: null,
		});
	});

	it("reports a missing file as absent", async () => {
		replies = [FOLDER, { files: [] }];

		expect(await adapter().getIfChanged?.("head", "aa")).toEqual({
			status: "absent",
		});
	});

	it("looks the id up again when the cached one answers 404", async () => {
		const drive = adapter();
		replies = [FOLDER, { files: [{ id: "9", name: "head" }] }];
		await drive.list("head");
		const head = { md5Checksum: "cc", headRevisionId: "r" };
		replies = [failed(404), { files: [{ id: "10" }] }, head, {}, head];

		expect(await drive.getIfChanged?.("head", "aa")).toMatchObject({
			status: "found",
			etag: "cc",
		});
		expect(requests.some(({ url }) => url.includes("/10?alt=media"))).toBe(
			true,
		);
	});
});

describe("Google Drive bulk write hint", () => {
	const keys = Array.from({ length: 256 }, (_, index) => `objects/${index}`);
	const searches = () =>
		requests.filter(({ url }) => new URL(url).searchParams.has("q"));
	const creates = () =>
		requests.filter(
			({ method, url }) => method === "POST" && url.includes("/upload/"),
		);

	it("lists the prefix once and creates absent keys without a lookup", async () => {
		const drive = adapter();
		drive.prepareWrites?.(keys);
		expect(requests).toEqual([]);
		const existing = { id: "E", name: "objects/3" };
		replies = [FOLDER, { files: [existing] }];
		await drive.put("objects/1", new Uint8Array([1]));
		await drive.put("objects/2", new Uint8Array([1]));
		await drive.put("objects/3", new Uint8Array([1]));

		expect(searches()).toHaveLength(2);
		expect(creates()).toHaveLength(2);
		expect(
			requests.some(
				({ method, url }) => method === "PATCH" && url.includes("/E?"),
			),
		).toBe(true);
	});

	it("still asks Drive for exists() and putIfAbsent()", async () => {
		const drive = adapter();
		drive.prepareWrites?.(keys);
		replies = [FOLDER, { files: [] }];
		await drive.put("objects/1", new Uint8Array([1]));
		const before = searches().length;
		replies = [{ files: [] }, { files: [{ id: "X" }] }];

		expect(await drive.exists("objects/2")).toBe(false);
		expect(await drive.putIfAbsent("objects/4", new Uint8Array([1]))).toBe(
			false,
		);
		expect(searches()).toHaveLength(before + 2);
	});
});

describe("Google Drive bulk ID priming is bounded by the batch", () => {
	const keys = Array.from({ length: 256 }, (_, index) => `objects/${index}`);
	const searches = () =>
		requests.filter(({ url }) => new URL(url).searchParams.has("q"));
	const page = (from: number, count: number, next?: string) => ({
		files: Array.from({ length: count }, (_, i) => ({
			id: `h${from + i}`,
			name: `objects/old${from + i}`,
		})),
		nextPageToken: next,
	});

	it("stops listing past a few pages of history and looks the rest up exactly", async () => {
		const drive = adapter();
		drive.prepareWrites?.(keys);
		replies = [
			FOLDER,
			page(0, 1000, "P2"),
			page(1000, 1000, "P3"),
			{ files: [] },
			{},
		];
		await drive.put("objects/1", new Uint8Array([1]));

		// Folder lookup, two list pages, then the exact lookup of the key: never the third page.
		expect(searches()).toHaveLength(4);
		expect(requests.some(({ url }) => url.includes("pageToken=P3"))).toBe(
			false,
		);
		expect(
			requests.some(
				({ method, url }) => method === "PATCH" && url.includes("/upload/"),
			),
		).toBe(false);
	});

	it("marks nothing absent after a cut-short listing", async () => {
		const drive = adapter();
		drive.prepareWrites?.(keys);
		// The exact lookup finds a file the truncated listing never reached.
		replies = [
			FOLDER,
			page(0, 1000, "P2"),
			page(1000, 1000, "P3"),
			{ files: [{ id: "late" }] },
			{},
		];
		await drive.put("objects/1", new Uint8Array([1]));

		expect(
			requests.some(
				({ method, url }) => method === "PATCH" && url.includes("/late?"),
			),
		).toBe(true);
	});

	it("stops a read listing once every hinted key has an id", async () => {
		const drive = adapter();
		drive.prepareReads?.(keys);
		replies = [
			FOLDER,
			{
				files: keys.map((name, index) => ({ id: String(index), name })),
				nextPageToken: "P2",
			},
			{},
		];
		await drive.get("objects/1");

		expect(requests.some(({ url }) => url.includes("pageToken=P2"))).toBe(
			false,
		);
	});

	it("keeps list() fully paginated", async () => {
		replies = [
			FOLDER,
			page(0, 1000, "P2"),
			page(1000, 1000, "P3"),
			page(2000, 1, undefined),
		];
		expect(await adapter().list("objects/")).toHaveLength(2001);
	});
});

describe("Google Drive file ids another device deleted", () => {
	const listed = () => [FOLDER, { files: [{ id: "9", name: "objects/x" }] }];

	it("are asked again by exists(), so a probe sees the deletion", async () => {
		const drive = adapter();
		replies = [...listed(), { files: [] }];
		await drive.list("objects/");

		expect(await drive.exists("objects/x")).toBe(false);
	});

	it("are looked up again when an upload to them answers 404", async () => {
		const drive = adapter();
		replies = [...listed(), failed(404), { files: [] }, { id: "10" }];
		await drive.list("objects/");

		await drive.put("objects/x", new Uint8Array([1]));

		const uploads = requests.filter(({ url }) => url.includes("/upload/"));
		expect(
			uploads.map(({ method, url }) => [method, url.includes("/9?")]),
		).toEqual([
			["PATCH", true],
			["POST", false],
		]);
	});

	it("are looked up again when a read of them answers 404", async () => {
		const drive = adapter();
		replies = [...listed(), failed(404), { files: [{ id: "10" }] }, {}];
		await drive.list("objects/");

		expect(await drive.get("objects/x")).not.toBeNull();
		expect(requests.at(-1)?.url).toContain("/10?alt=media");
	});
});

describe("Google Drive 403s that are no refusal", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a rate limit Drive sends as 403", async () => {
		vi.useFakeTimers();
		const limited = failed(403, {
			error: { errors: [{ reason: "userRateLimitExceeded" }] },
		});
		replies = [limited, FOLDER, { files: [] }];

		const probe = adapter().exists("k");
		await vi.runAllTimersAsync();

		expect(await probe).toBe(false);
	});

	it("says the Drive is full instead of refusing the keys", async () => {
		replies = [
			failed(403, { error: { errors: [{ reason: "storageQuotaExceeded" }] } }),
		];

		const err = await adapter()
			.exists("k")
			.catch((e: unknown) => e);

		expect(isRefusedCredentials(err)).toBe(false);
		expect(err).toMatchObject({
			name: "StorageRequestError",
			userMessage:
				"Google Drive is full. Free up space in it, then sync again.",
		});
	});
});

describe("Google Drive token refresh", () => {
	it("asks the auth server for a new token", async () => {
		replies = [{ access_token: "n", expires_in: 3600 }, FOLDER, { files: [] }];
		const drive = createGoogleDriveAdapter({
			kind: EStorageBackend.GoogleDrive,
			folderName: "mdsync",
			authServerUrl: "https://auth.example/",
			accessToken: "old",
			refreshToken: "r",
			expiresAt: 0,
			concurrency: 4,
		});

		await drive.exists("k");

		expect(requests[0]?.url).toBe("https://auth.example/refresh");
	});
});
