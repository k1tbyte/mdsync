import { requestUrl } from "obsidian";

import { DEFAULT_CONCURRENCY } from "@/constants";
import { normalizeKeyPrefix } from "@/shared";
import { EStorageBackend, type WebDAVStorageConfig } from "@/storage/config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "@/storage/field-spec";
import type {
	ConditionalRead,
	ListedObject,
	StorageAdapter,
} from "@/storage/types";
import { bytesToBase64, toArrayBuffer } from "@/utils";
import {
	assertOk,
	dateOf,
	headerValue,
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

const PROPFIND_BODY =
	'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>';
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const HTTP_NOT_MODIFIED = 304;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_MULTI_STATUS = 207;
const HTTP_PRECONDITION_FAILED = 412;

export const WEBDAV_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		kind: EFieldKind.Text,
		key: "baseUrl",
		name: "Base URL",
		desc: "WebDAV server root, e.g. https://example.com/remote.php/dav/files/user/",
		placeholder: "https://example.com/remote.php/dav/files/user/",
	},
	{
		kind: EFieldKind.Text,
		key: "basePath",
		name: "Path",
		desc: "Subfolder inside the WebDAV root. Created on first push.",
		placeholder: "mdsync/",
	},
	{ kind: EFieldKind.Text, key: "username", name: "Username" },
	{ kind: EFieldKind.Password, key: "password", name: "Password" },
	CONCURRENCY_FIELD,
];

export function defaultWebDAVConfig(): WebDAVStorageConfig {
	return {
		kind: EStorageBackend.WebDAV,
		baseUrl: "",
		basePath: "mdsync/",
		username: "",
		password: "",
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export function isWebDAVConfigured(config: WebDAVStorageConfig): boolean {
	return Boolean(config.baseUrl && config.username && config.password);
}

export function webdavIdentity(config: WebDAVStorageConfig): string {
	return `webdav|${config.baseUrl}|${config.basePath}|${config.username}`;
}

export function describeWebDAVTarget(config: WebDAVStorageConfig): string {
	const url = config.baseUrl || "(not configured)";
	const path = config.basePath || "(server root)";
	return `WebDAV: ${url} / path: ${path}`;
}

export function createWebDAVAdapter(
	config: WebDAVStorageConfig,
): StorageAdapter {
	assertConfig(config);
	const baseUrl = ensureTrailingSlash(config.baseUrl);
	const basePath = normalizeKeyPrefix(config.basePath);
	// Encode path segments to prevent invalid requests (e.g. from spaces).
	const rootUrl = baseUrl + encodeKey(basePath);
	const auth = `Basic ${basicCredentials(config.username, config.password)}`;
	const knownDirs = new Set<string>();
	knownDirs.add("");

	const buildHeaders = (
		extra: Record<string, string> = {},
	): Record<string, string> => ({
		Authorization: auth,
		...extra,
	});

	const urlForKey = (key: string): string => rootUrl + encodeKey(key);

	const readObject = async (
		key: string,
		etag: string | null,
	): Promise<ConditionalRead> => {
		const res = await davRequest({
			url: urlForKey(key),
			method: "GET",
			headers: buildHeaders(etag ? { "If-None-Match": etag } : {}),
			throw: false,
		});
		// A server ignoring the precondition answers 200: an unconditional read. A 304 to a read with no
		// validator describes nothing, and a plain read's caller would take it for an absent object.
		if (res.status === HTTP_NOT_MODIFIED) {
			if (!etag) {
				throw new Error(
					`WebDAV answered 304 to an unconditional read of "${key}".`,
				);
			}
			return { status: "unchanged" };
		}
		if (res.status === HTTP_NOT_FOUND) return { status: "absent" };
		assertOk(res, "read", key);
		return {
			status: "found",
			body: new Uint8Array(res.arrayBuffer),
			etag: headerValue(res.headers, "etag"),
		};
	};

	async function ensureParentDir(key: string): Promise<void> {
		const fullPath = basePath + key;
		const idx = fullPath.lastIndexOf("/");
		if (idx < 0) return;
		const dir = fullPath.slice(0, idx + 1);
		if (knownDirs.has(dir)) return;
		const parts = dir.split("/").filter(Boolean);
		let cursor = "";
		for (const part of parts) {
			cursor = `${cursor}${part}/`;
			if (knownDirs.has(cursor)) continue;
			const url = baseUrl + encodeKey(cursor);
			const res = await davRequest({
				url,
				method: "MKCOL",
				headers: buildHeaders(),
				throw: false,
			});
			// 405: the collection exists. 409: a parent is missing, which this loop creates first, so
			// accepting it would cache a nonexistent directory and fail every later PUT.
			if (isSuccess(res.status) || res.status === HTTP_METHOD_NOT_ALLOWED) {
				knownDirs.add(cursor);
				continue;
			}
			throw new StorageHttpError(
				res.status,
				`WebDAV MKCOL "${cursor}" failed (HTTP ${res.status})`,
			);
		}
	}

	const listObjects = async (keyPrefix: string): Promise<ListedObject[]> => {
		// Depth 1 reports only direct children: objects/ sits one level below the root and would be
		// invisible without recursing.
		const seen = new Set<string>();
		const objects: ListedObject[] = [];
		const queue = [keyPrefix ? ensureTrailingSlash(keyPrefix) : ""];
		while (queue.length > 0) {
			const dir = queue.shift() as string;
			if (seen.has(dir)) continue;
			seen.add(dir);
			const res = await davRequest({
				url: rootUrl + encodeKey(dir),
				method: "PROPFIND",
				headers: buildHeaders({
					Depth: "1",
					"Content-Type": "application/xml; charset=utf-8",
				}),
				body: PROPFIND_BODY,
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) continue;
			if (res.status !== HTTP_MULTI_STATUS) {
				throw new StorageHttpError(
					res.status,
					`WebDAV PROPFIND "${dir}" failed (HTTP ${res.status})`,
				);
			}
			const listed = parsePropfindResponse(res.text, rootUrl);
			objects.push(...listed.files);
			for (const child of listed.collections) {
				if (child !== dir) queue.push(child);
			}
		}
		return objects;
	};

	return {
		identity() {
			return webdavIdentity(config);
		},
		async exists(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "HEAD",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return false;
			assertOk(res, "check", key);
			return true;
		},
		async get(key) {
			const read = await readObject(key, null);
			return read.status === "found" ? read.body : null;
		},
		getIfChanged: readObject,
		async put(key, body, contentType) {
			const res = await sendPut(key, body, contentType);
			assertOk(res, "write", key);
		},
		async putIfAbsent(key, body, contentType) {
			const res = await sendPut(key, body, contentType, {
				"If-None-Match": "*",
			});
			if (res.status === HTTP_PRECONDITION_FAILED) return false;
			assertOk(res, "write", key);
			return true;
		},
		async delete(key) {
			const res = await davRequest({
				url: urlForKey(key),
				method: "DELETE",
				headers: buildHeaders(),
				throw: false,
			});
			if (res.status === HTTP_NOT_FOUND) return;
			assertOk(res, "delete", key);
		},
		async list(keyPrefix) {
			return (await listObjects(keyPrefix)).map((object) => object.key);
		},
		listDetailed: listObjects,
	};

	async function sendPut(
		key: string,
		body: Uint8Array,
		contentType: string | undefined,
		extraHeaders: Record<string, string> = {},
	): ReturnType<typeof davRequest> {
		await ensureParentDir(key);
		return davRequest({
			url: urlForKey(key),
			method: "PUT",
			headers: buildHeaders({
				"Content-Type": contentType ?? "application/octet-stream",
				...extraHeaders,
			}),
			body: toArrayBuffer(body),
			throw: false,
		});
	}
}

/**
 * `requestUrl` under the shared timeout and retry policy. Every WebDAV verb used here is idempotent, so
 * retrying transport failures or "try later" statuses is safe; other statuses go to the caller.
 */
async function davRequest(
	params: Parameters<typeof requestUrl>[0],
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
	return withRetry(async () => {
		const res = await withTimeout(requestUrl(params), STORAGE_TIMEOUT_MS);
		if (isRetryableStatus(res.status)) {
			throw new StorageHttpError(
				res.status,
				`WebDAV request failed (HTTP ${res.status})`,
			);
		}
		return res;
	});
}

/** Basic auth is Latin-1 by definition: a non-ASCII password must be UTF-8 encoded before base64 or `btoa` throws. */
function basicCredentials(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	return bytesToBase64(bytes);
}

function assertConfig(config: WebDAVStorageConfig): void {
	if (!config.baseUrl) throw new Error("WebDAV base URL is not configured");
	if (!config.username || !config.password) {
		throw new Error("WebDAV credentials are not configured");
	}
}

function ensureTrailingSlash(value: string): string {
	if (!value) return value;
	return value.endsWith("/") ? value : `${value}/`;
}

function encodeKey(key: string): string {
	return key
		.split("/")
		.map((segment) => (segment === "" ? "" : encodeURIComponent(segment)))
		.join("/");
}

function isSuccess(status: number): boolean {
	return status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
}

interface PropfindListing {
	files: ListedObject[];
	collections: string[];
}

function parsePropfindResponse(
	xmlText: string,
	rootUrl: string,
): PropfindListing {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, "application/xml");
	if (doc.getElementsByTagName("parsererror").length > 0) {
		throw new Error("WebDAV sent a listing that could not be read");
	}
	const responses = doc.getElementsByTagNameNS("DAV:", "response");
	const listing: PropfindListing = { files: [], collections: [] };
	let inside = 0;
	for (let i = 0; i < responses.length; i++) {
		const node = responses.item(i);
		if (!node) continue;
		const hrefEl = node.getElementsByTagNameNS("DAV:", "href").item(0);
		if (!hrefEl) continue;
		const href = (hrefEl.textContent ?? "").trim();
		if (!href) continue;
		const relative = relativizeHref(href, rootUrl);
		if (relative === null) continue;
		inside++;
		const resourceType = node
			.getElementsByTagNameNS("DAV:", "resourcetype")
			.item(0);
		const isCollection = Boolean(
			resourceType?.getElementsByTagNameNS("DAV:", "collection").length,
		);
		if (isCollection) {
			if (relative) listing.collections.push(ensureTrailingSlash(relative));
		} else {
			listing.files.push({
				key: relative,
				etag: propertyText(node, "getetag"),
				modified: dateOf(propertyText(node, "getlastmodified")),
			});
		}
	}
	if (responses.length > 0 && inside === 0) {
		throw new Error("WebDAV listed paths outside the configured folder");
	}
	return listing;
}

/** Empty when the server 404s the property, i.e. has no validators. */
function propertyText(response: Element, name: string): string | null {
	const text = response
		.getElementsByTagNameNS("DAV:", name)
		.item(0)?.textContent;
	return text?.trim() || null;
}

/**
 * Href to a key relative to the configured root, compared as parsed URLs: `https://host:443/` and
 * `https://host/` are one origin, and a textual prefix test drops every entry when the spellings differ.
 */
function relativizeHref(href: string, rootUrl: string): string | null {
	let absolute: URL;
	let root: URL;
	try {
		absolute = new URL(href, rootUrl);
		root = new URL(rootUrl);
	} catch {
		return null;
	}
	if (absolute.origin !== root.origin) return null;
	const rootPath = decodeLoosely(root.pathname);
	const path = decodeLoosely(absolute.pathname);
	return path.startsWith(rootPath) ? path.slice(rootPath.length) : null;
}

function decodeLoosely(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}
