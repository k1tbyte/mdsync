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

const adapter = () =>
	createWebDAVAdapter({
		kind: EStorageBackend.WebDAV,
		baseUrl: "https://dav.example/dav/",
		basePath: "obsync/",
		username: "u",
		password: "p",
		concurrency: 4,
	});

const ROOT = "/dav/obsync/";
const collection = (path: string) =>
	`<d:response><d:href>${ROOT}${path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const file = (path: string, etag?: string) =>
	`<d:response><d:href>${ROOT}${path}</d:href><d:propstat><d:prop><d:resourcetype/>${etag ? `<d:getetag>${etag}</d:getetag>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${etag ? "" : `<d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`}</d:response>`;
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

		await adapter().listWithEtags?.("spaces/");

		expect(requests[0]?.method).toBe("PROPFIND");
		expect(requests[0]?.body).toContain("<d:getetag/>");
	});

	it("reports each file's decoded etag, and none for a server that has none", async () => {
		replies = [
			multistatus(
				collection("spaces/"),
				file("spaces/a.json.enc", "&quot;e1&quot;"),
				file("spaces/b.json.enc"),
			),
		];

		expect(await adapter().listWithEtags?.("spaces/")).toEqual([
			{ key: "spaces/a.json.enc", etag: '"e1"' },
			{ key: "spaces/b.json.enc", etag: null },
		]);
	});

	it("walks into collections and lists keys alone", async () => {
		replies = [
			multistatus(collection(""), collection("spaces/"), file("root", '"r"')),
			multistatus(collection("spaces/"), file("spaces/a", '"e1"')),
		];

		expect(await adapter().list("")).toEqual(["root", "spaces/a"]);
		expect(requests.map((request) => request.url)).toEqual([
			"https://dav.example/dav/obsync/",
			"https://dav.example/dav/obsync/spaces/",
		]);
	});
});
