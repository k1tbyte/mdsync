import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleDriveAdapter } from "@/storage/adapters/google-drive";
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
	it("reports the md5 checksum as the etag, none for a file without one, across pages", async () => {
		replies = [
			FOLDER,
			{
				files: [
					{ id: "1", name: "spaces/a.json.enc", md5Checksum: "aa" },
					{ id: "2", name: "objects/x", md5Checksum: "xx" },
				],
				nextPageToken: "P2",
			},
			{ files: [{ id: "3", name: "spaces/b.json.enc" }] },
		];

		expect(await adapter().listWithEtags?.("spaces/")).toEqual([
			{ key: "spaces/a.json.enc", etag: "aa" },
			{ key: "spaces/b.json.enc", etag: null },
		]);
		expect(decodeURIComponent(requests[1]?.url ?? "")).toContain(
			"files(id,name,md5Checksum)",
		);
		expect(requests[2]?.url).toContain("pageToken=P2");
	});

	it("lists keys alone", async () => {
		replies = [
			FOLDER,
			{ files: [{ id: "1", name: "spaces/a.json.enc", md5Checksum: "aa" }] },
		];

		expect(await adapter().list("spaces/")).toEqual(["spaces/a.json.enc"]);
	});
});
