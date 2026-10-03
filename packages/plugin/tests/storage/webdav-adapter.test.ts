import { FakeDOMParser } from "@tests/helpers/dom-parser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebDAVAdapter } from "@/storage/adapters/webdav";
import { EStorageBackend } from "@/storage/config";

interface Recorded {
	url: string;
	method: string;
	body?: string;
}

const requests: Recorded[] = [];
let replies: { status: number; text: string }[] = [];

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestUrl: (params: Recorded) => {
		requests.push(params);
		const reply = replies.shift() ?? { status: 404, text: "" };
		return Promise.resolve({
			...reply,
			arrayBuffer: new ArrayBuffer(0),
			json: {},
			headers: {},
		});
	},
}));

const adapter = (basePath = "mdsync/") =>
	createWebDAVAdapter({
		kind: EStorageBackend.WebDAV,
		baseUrl: "https://dav.example/dav/",
		basePath,
		username: "u",
		password: "p",
		concurrency: 4,
	});

const ROOT = "/dav/mdsync/";
const collection = (path: string) =>
	`<d:response><d:href>${ROOT}${path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const file = (path: string, etag?: string, modified?: string) =>
	`<d:response><d:href>${ROOT}${path}</d:href><d:propstat><d:prop><d:resourcetype/>${etag ? `<d:getetag>${etag}</d:getetag>` : ""}${modified ? `<d:getlastmodified>${modified}</d:getlastmodified>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${etag ? "" : `<d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`}</d:response>`;
const multistatus = (...responses: string[]) => ({
	status: 207,
	text: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`,
});

beforeEach(() => {
	vi.stubGlobal("DOMParser", FakeDOMParser);
	requests.length = 0;
	replies = [];
});

describe("WebDAV listings", () => {
	it("asks for each entry's etag", async () => {
		replies = [multistatus(collection("spaces/"))];

		await adapter().listDetailed?.("spaces/");

		expect(requests[0]?.method).toBe("PROPFIND");
		expect(requests[0]?.body).toContain("<d:getetag/>");
	});

	it("reports each file's decoded etag and last write, and none for a server that has none", async () => {
		replies = [
			multistatus(
				collection("spaces/"),
				file(
					"spaces/a.json.enc",
					"&quot;e1&quot;",
					"Wed, 30 Sep 2026 10:00:00 GMT",
				),
				file("spaces/b.json.enc"),
			),
		];

		expect(await adapter().listDetailed?.("spaces/")).toEqual([
			{
				key: "spaces/a.json.enc",
				etag: '"e1"',
				modified: Date.UTC(2026, 8, 30, 10),
			},
			{ key: "spaces/b.json.enc", etag: null, modified: null },
		]);
	});

	it("walks into collections and lists keys alone", async () => {
		replies = [
			multistatus(collection(""), collection("spaces/"), file("root", '"r"')),
			multistatus(collection("spaces/"), file("spaces/a", '"e1"')),
		];

		expect(await adapter().list("")).toEqual(["root", "spaces/a"]);
		expect(requests.map((request) => request.url)).toEqual([
			"https://dav.example/dav/mdsync/",
			"https://dav.example/dav/mdsync/spaces/",
		]);
	});

	it("reads hrefs a server escapes differently from the request", async () => {
		const href = (path: string) =>
			`<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
		replies = [
			multistatus(
				href("/dav/Bob%27s%20vault/spaces/a.json.enc"),
				href("/dav/bob%27s%20vault/spaces/ignored.enc"),
				href("/dav/Bob's%20vault/spaces/b.json.enc"),
			),
		];

		expect(await adapter("Bob's vault/").list("spaces/")).toEqual([
			"spaces/a.json.enc",
			"spaces/b.json.enc",
		]);
	});

	it("does not take a listing it cannot read for an empty folder", async () => {
		replies = [
			{ status: 207, text: "<parsererror>not well-formed</parsererror>" },
		];

		await expect(adapter().list("spaces/")).rejects.toThrow(
			/could not be read/,
		);
	});

	it("does not take a listing of another folder for an empty one", async () => {
		replies = [
			multistatus(
				`<d:response><d:href>/elsewhere/x</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
			),
		];

		await expect(adapter().list("spaces/")).rejects.toThrow(/outside/);
	});
});
