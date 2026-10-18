import type { RequestUrlParam } from "obsidian";
import type { GoogleDriveStorageConfig } from "@/storage/config";
import type {
	ConditionalRead,
	ListedObject,
	StorageAdapter,
} from "@/storage/types";
import {
	computeExpiresAt,
	googleAuthUrl,
	googleDriveIdentity,
} from "./google-drive-auth";
import { type AuthorizedRequest, driveRequest } from "./google-drive-request";
import { sendUpload } from "./google-drive-upload";
import { assertOk, dateOf, StorageHttpError } from "./util";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_PAGE_SIZE = "1000";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const PREPARE_READS_MIN = 256;
const NOT_FOUND = 404;

interface GoogleDriveListResponse {
	files?: {
		id?: string;
		name?: string;
		md5Checksum?: string;
		modifiedTime?: string;
	}[];
	nextPageToken?: string;
}

/** Escapes value for Google Drive 'q' literal to prevent query breakage. */
function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Best-effort backend for a content-addressed store: no conditional write or atomic create-by-name, so two
 * devices writing the same new key at once can produce duplicate files. Everything else follows the shared
 * contract: an error is never reported as absence.
 */
export function createGoogleDriveAdapter(
	config: GoogleDriveStorageConfig,
	onTokenRefreshed?: () => void,
): StorageAdapter {
	let cachedFolderId: string | null = null;
	let folderLookup: Promise<string> | null = null;
	let tokenRefresh: Promise<void> | null = null;
	// name -> file id. Only positive entries are cached: a negative one would keep reporting a file another
	// device uploaded this session as missing, failing the pull.
	const fileIdCache = new Map<string, string>();
	let readHint: {
		keys: Set<string>;
		prefix: string;
		ready?: Promise<void>;
	} | null = null;
	let writeHint: {
		keys: Set<string>;
		prefix: string;
		ready?: Promise<void>;
		// Hinted keys the listing did not find. Only put() may create them unlooked: exists() and putIfAbsent() must ask.
		absent?: Set<string>;
	} | null = null;

	const refreshAccessToken = async (): Promise<void> => {
		const res = await driveRequest({
			url: googleAuthUrl(config, "/refresh"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ refresh_token: config.refreshToken }),
			throw: false,
		});
		if (res.status !== 200) {
			throw new StorageHttpError(
				res.status,
				`Google Drive token refresh failed (HTTP ${res.status})`,
			);
		}
		const tokenData = res.json as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!tokenData.access_token) {
			throw new Error("Google Drive token refresh returned no access token");
		}
		config.accessToken = tokenData.access_token;
		// Google rotates refresh tokens on some accounts: dropping the new one leaves the next refresh
		// holding a revoked credential.
		if (tokenData.refresh_token) config.refreshToken = tokenData.refresh_token;
		config.expiresAt = computeExpiresAt(tokenData.expires_in);
		onTokenRefreshed?.();
	};

	// Every worker shares one refresh: parallel uploads must not each refresh and race each other's tokens.
	const refreshOnce = async (): Promise<void> => {
		tokenRefresh ??= refreshAccessToken().finally(() => {
			tokenRefresh = null;
		});
		await tokenRefresh;
	};

	const getHeaders = async (): Promise<Record<string, string>> => {
		if (needsRefresh(config)) await refreshOnce();
		return {
			Authorization: `Bearer ${config.accessToken}`,
			"Content-Type": "application/json",
		};
	};

	/** Drive answers 401 mid-run (not retryable); replaces the token so long syncs do not fail. */
	const authorized: AuthorizedRequest = async (params) => {
		const build = async (): Promise<RequestUrlParam> => ({
			...params,
			headers: { ...(await getHeaders()), ...params.headers },
			throw: false,
		});
		const first = await driveRequest(await build());
		if (first.status !== 401) return first;
		await refreshOnce();
		return driveRequest(await build());
	};

	const findFolder = async (): Promise<string | null> => {
		const q = `name = '${escapeDriveQueryValue(config.folderName)}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
		const res = await authorized({
			url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
			method: "GET",
		});
		// A failed search must not fall through to "create": a 5xx would make a second sync folder.
		assertOk(res, "find folder", config.folderName);
		const data = res.json as GoogleDriveListResponse;
		return data.files?.[0]?.id ?? null;
	};

	const getFolderId = async (): Promise<string> => {
		if (cachedFolderId) return cachedFolderId;
		folderLookup ??= (async () => {
			const existing = await findFolder();
			if (existing) {
				cachedFolderId = existing;
				return existing;
			}
			const createRes = await authorized({
				url: DRIVE_API,
				method: "POST",
				body: JSON.stringify({
					name: config.folderName,
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root"],
				}),
			});
			assertOk(createRes, "create folder", config.folderName);
			const created = (createRes.json as { id?: string }).id;
			if (!created) {
				throw new Error("Google Drive create folder returned no id");
			}
			cachedFolderId = created;
			return created;
		})().finally(() => {
			folderLookup = null;
		});
		return folderLookup;
	};

	const findFileId = async (key: string): Promise<string | null> => {
		const cached = fileIdCache.get(key);
		if (cached) return cached;
		const folderId = await getFolderId();
		const q = `name = '${escapeDriveQueryValue(key)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
		const res = await authorized({
			url: `${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`,
			method: "GET",
		});
		assertOk(res, "look up", key);
		const data = res.json as GoogleDriveListResponse;
		const id = data.files?.[0]?.id ?? null;
		if (id) fileIdCache.set(key, id);
		return id;
	};

	const upload = async (
		key: string,
		body: Uint8Array,
		contentType: string | undefined,
		existingId: string | null,
	): Promise<void> => {
		const context = { folderId: await getFolderId() };
		const id = await sendUpload(
			key,
			body,
			contentType,
			existingId,
			authorized,
			context,
		).catch(async (err: unknown) => {
			if (!existingId || !isNotFound(err)) throw err;
			// The cached id may name a file another device deleted since.
			fileIdCache.delete(key);
			return sendUpload(
				key,
				body,
				contentType,
				await findFileId(key),
				authorized,
				context,
			);
		});
		if (id) fileIdCache.set(key, id);
	};

	const download = async (key: string): Promise<Uint8Array | null> => {
		const id = await findFileId(key);
		if (!id) return null;
		const res = await authorized({
			url: `${DRIVE_API}/${id}?alt=media`,
			method: "GET",
		});
		if (res.status === NOT_FOUND) {
			fileIdCache.delete(key);
			return null;
		}
		assertOk(res, "download", key);
		return new Uint8Array(res.arrayBuffer);
	};

	/** Null once the id is gone. */
	const revisionOf = async (
		key: string,
		id: string,
	): Promise<{ md5Checksum?: string; headRevisionId?: string } | null> => {
		const res = await authorized({
			url: `${DRIVE_API}/${id}?fields=md5Checksum,headRevisionId`,
			method: "GET",
		});
		if (res.status === NOT_FOUND) {
			fileIdCache.delete(key);
			return null;
		}
		assertOk(res, "look up", key);
		return res.json as { md5Checksum?: string; headRevisionId?: string };
	};

	/** A hint is worth one listing when many uncached keys share a prefix. */
	const hintOf = (keys: string[]) => {
		const missing = keys.filter((key) => !fileIdCache.has(key));
		const first = missing[0];
		const prefix = first?.slice(0, first.lastIndexOf("/") + 1) ?? "";
		return missing.length >= PREPARE_READS_MIN &&
			prefix !== "" &&
			missing.every((key) => key.startsWith(prefix))
			? { keys: new Set(missing), prefix }
			: null;
	};

	const listObjects = async (
		prefix: string,
		detailed: boolean,
	): Promise<ListedObject[]> => {
		const objects: ListedObject[] = [];
		let pageToken: string | undefined;
		const folderId = await getFolderId();

		const parentQuery = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
		const q = prefix
			? `${parentQuery} and name contains '${escapeDriveQueryValue(prefix)}'`
			: parentQuery;

		do {
			const url = new URL(DRIVE_API);
			url.searchParams.set("q", q);
			url.searchParams.set("pageSize", DRIVE_PAGE_SIZE);
			url.searchParams.set(
				"fields",
				`nextPageToken, files(id,name${detailed ? ",md5Checksum,modifiedTime" : ""})`,
			);
			if (pageToken) url.searchParams.set("pageToken", pageToken);

			const res = await authorized({
				url: url.toString(),
				method: "GET",
			});
			assertOk(res, "list", prefix);

			const data = res.json as GoogleDriveListResponse;
			for (const f of data.files ?? []) {
				if (!f.name) continue;
				// Prime the id cache so later get()/put() avoid a lookup.
				if (f.id) fileIdCache.set(f.name, f.id);
				if (f.name.startsWith(prefix)) {
					objects.push({
						key: f.name,
						etag: f.md5Checksum ?? null,
						modified: dateOf(f.modifiedTime),
					});
				}
			}
			pageToken = data.nextPageToken;
		} while (pageToken);

		return objects;
	};

	return {
		identity: () => googleDriveIdentity(config),

		/** Always asks Drive: callers probe to learn whether another device deleted the file. */
		async exists(key: string): Promise<boolean> {
			fileIdCache.delete(key);
			return (await findFileId(key)) !== null;
		},

		prepareReads(keys) {
			readHint = hintOf(keys);
		},

		prepareWrites(keys) {
			writeHint = hintOf(keys);
		},

		async get(key: string): Promise<Uint8Array | null> {
			if (readHint?.keys.has(key) && !fileIdCache.has(key)) {
				const hint = readHint;
				hint.ready ??= listObjects(hint.prefix, false).then(
					() => undefined,
					() => undefined,
				);
				await hint.ready;
				if (readHint === hint) readHint = null;
			}
			const cached = fileIdCache.has(key);
			const body = await download(key);
			// The cached id may name a file deleted and recreated since.
			return body ?? (cached ? download(key) : null);
		},

		async getIfChanged(key, etag): Promise<ConditionalRead> {
			const attempt = async (): Promise<ConditionalRead | null> => {
				const id = await findFileId(key);
				if (!id) return { status: "absent" };
				const before = await revisionOf(key, id);
				if (!before) return null;
				// Blobs are re-encrypted on every write, so a content md5 never returns to an old value.
				const md5 = before.md5Checksum ?? null;
				if (md5 && md5 === etag) return { status: "unchanged" };
				const body = await download(key);
				if (!body) return null;
				// Separate requests: only the same head revision on both sides proves the md5 names these bytes.
				const rev = before.headRevisionId;
				const after = rev ? await revisionOf(key, id) : null;
				const bound = rev && after?.headRevisionId === rev;
				return { status: "found", body, etag: bound ? md5 : null };
			};
			// The cached id may name a file deleted and recreated since.
			return (await attempt()) ?? (await attempt()) ?? { status: "absent" };
		},

		async put(key, body, contentType) {
			const hint = writeHint;
			if (hint?.keys.has(key) && !fileIdCache.has(key)) {
				hint.ready ??= listObjects(hint.prefix, false).then(
					() => {
						hint.absent = new Set(
							[...hint.keys].filter((name) => !fileIdCache.has(name)),
						);
					},
					() => undefined,
				);
				await hint.ready;
			}
			// An id learned since the listing (exists, putIfAbsent) wins over the negative.
			const create = hint?.absent?.delete(key) && !fileIdCache.has(key);
			await upload(
				key,
				body,
				contentType,
				create ? null : await findFileId(key),
			);
		},

		async putIfAbsent(key, body, contentType) {
			// Drive has no conditional create. Probing closes ordinary race; genuine tie leaves duplicate
			// resolved arbitrarily - documented, not solved.
			if (await findFileId(key)) return false;
			await upload(key, body, contentType, null);
			return true;
		},

		async delete(key: string): Promise<void> {
			const id = await findFileId(key);
			if (!id) return;
			const res = await authorized({
				url: `${DRIVE_API}/${id}`,
				method: "DELETE",
			});
			fileIdCache.delete(key);
			if (res.status === NOT_FOUND) return;
			assertOk(res, "delete", key);
		},

		async list(prefix: string): Promise<string[]> {
			return (await listObjects(prefix, false)).map((object) => object.key);
		},
		listDetailed: (prefix: string) => listObjects(prefix, true),
	};
}

function needsRefresh(config: GoogleDriveStorageConfig): boolean {
	if (!config.refreshToken) return false;
	if (!config.accessToken) return true;
	// A config restored without an expiry, or past it, must refresh rather than send a probably dead token.
	return (
		!config.expiresAt || Date.now() > config.expiresAt - TOKEN_REFRESH_MARGIN_MS
	);
}

function isNotFound(err: unknown): boolean {
	return err instanceof StorageHttpError && err.status === NOT_FOUND;
}
