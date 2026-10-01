import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleDriveAdapter } from "@/storage/adapters/google-drive";
import { DEFAULT_GDRIVE_AUTH_SERVER } from "@/storage/adapters/google-drive-auth";
import { EStorageBackend } from "@/storage/config";

const requests: { url: string }[] = [];
let replies: unknown[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: { url: string }) => {
		requests.push(params);
		return Promise.resolve({
			status: 200,
			json: replies.shift() ?? {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
			headers: {},
		});
	},
}));

const adapter = () =>
	createGoogleDriveAdapter({
		kind: EStorageBackend.GoogleDrive,
		folderName: "obsync",
		clientId: "c",
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

describe("Google Drive token refresh", () => {
	it.each([
		["https://auth.example/", "https://auth.example/refresh"],
		["", `${DEFAULT_GDRIVE_AUTH_SERVER}/refresh`],
	])("asks %j for a new token at %s", async (authServerUrl, expected) => {
		replies = [{ access_token: "n", expires_in: 3600 }, FOLDER, { files: [] }];
		const drive = createGoogleDriveAdapter({
			kind: EStorageBackend.GoogleDrive,
			folderName: "obsync",
			clientId: "",
			authServerUrl,
			accessToken: "old",
			refreshToken: "r",
			expiresAt: 0,
			concurrency: 4,
		});

		await drive.exists("k");

		expect(requests[0]?.url).toBe(expected);
	});
});
