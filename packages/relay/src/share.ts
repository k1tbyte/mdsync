/**
 * Shared-folder broker.
 *
 * Participants never hold storage credentials. They hold a share token; the broker
 * exchanges it for a short-lived presigned S3 URL scoped to a single key inside
 * `shares/<shareId>/`. Object bytes go between the participant and S3 - the broker only signs.
 *
 * The broker has no S3 config of its own: the owner's plugin registers each share's
 * base location and credentials, so a deploy needs no storage secrets.
 */

import { type HubEnv, hubStub } from "./hub";
import { fingerprint, isAdmin, type SecretEnv } from "./secret";
import {
	InvalidShareKeyError,
	shareBasePrefix,
	shareListPrefix,
	shareObjectKey,
} from "./share-key";
import { type PresignMethod, presignS3, type S3Target } from "./sigv4";

export interface ShareEnv extends Cloudflare.Env, SecretEnv, HubEnv {
	SHARE_TOKENS: KVNamespace;
}

export const EShareRole = {
	ReadWrite: "rw",
	ReadOnly: "ro",
} as const;
export type EShareRole = (typeof EShareRole)[keyof typeof EShareRole];

interface TokenRecord {
	shareId: string;
	participantId: string;
	role: EShareRole;
	label?: string;
	createdAt: number;
}

/** `prefix` is the base prefix; share-key.ts appends `shares/<shareId>/`. */
type ShareStorage = S3Target & { prefix: string };

type JsonObject = Record<string, unknown>;

const PRESIGN_TTL_SECONDS = 120;
/** S3's own ceiling for one ListObjectsV2 page. */
const MAX_PAGE_SIZE = 1000;
const TOKEN_BYTES = 32;
/** Rides in each hub socket's 16 KB attachment as `who`. */
const MAX_PARTICIPANT_ID_LENGTH = 64;
const WRITE_OPS = new Set(["put", "delete"]);
const REQUIRED_STORAGE_FIELDS = [
	"endpoint",
	"bucket",
	"accessKeyId",
	"secretAccessKey",
] as const;
const SHARES_PATH = "/share/shares/";
const TOKENS_PATH = "/share/tokens/";
const JSON_HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
};

/** Returns null when the path is not a broker route, so index.ts can fall through. */
export async function handleShareRequest(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/share/")) return null;

	if (url.pathname === "/share/sign") {
		if (request.method !== "POST") return methodNotAllowed("POST");
		return signObject(request, env);
	}
	if (url.pathname.startsWith(SHARES_PATH)) {
		const shareId = url.pathname.slice(SHARES_PATH.length);
		if (request.method === "PUT") return registerShare(request, env, shareId);
		if (request.method === "DELETE") return endShare(request, env, shareId);
		return methodNotAllowed("DELETE, PUT");
	}
	if (url.pathname === "/share/tokens") {
		if (request.method === "POST") return issueToken(request, env);
		if (request.method === "GET") return listTokens(request, env, url);
		return methodNotAllowed("GET, POST");
	}
	if (url.pathname === "/share/token") {
		if (request.method !== "DELETE") return methodNotAllowed("DELETE");
		return leaveShare(request, env);
	}
	if (url.pathname.startsWith(TOKENS_PATH)) {
		if (request.method !== "DELETE") return methodNotAllowed("DELETE");
		return revokeToken(request, env, url);
	}
	return jsonError(404, "not_found", "Unknown broker route");
}

/** Whose live token this is and for which share; null once it is revoked. */
export async function shareGrantOf(
	env: ShareEnv,
	token: string,
): Promise<TokenRecord | null> {
	return (await env.SHARE_TOKENS.get(
		`tok:${token}`,
		"json",
	)) as TokenRecord | null;
}

/* -------------------------------------------------------------- participant */

/** A participant leaving revokes the token they hold, never one issued after it. */
async function leaveShare(request: Request, env: ShareEnv): Promise<Response> {
	const token = bearerOf(request);
	const record = token && (await shareGrantOf(env, token));
	if (!token || !record) return json({ revoked: false });
	const pointer = pointerKey(record.shareId, record.participantId);
	if ((await env.SHARE_TOKENS.get(pointer)) === token) {
		await env.SHARE_TOKENS.delete(pointer);
	}
	await dropToken(env, token);
	return json({ revoked: true });
}

async function signObject(request: Request, env: ShareEnv): Promise<Response> {
	const record = await readToken(request, env);
	if (!record) return jsonError(401, "unauthorized", "Invalid share token");

	const body = await readJsonObject(request);
	if (!body) return jsonError(400, "bad_request", "Invalid JSON body");

	// Fields are participant-controlled: a number reaching assertSafeKey would throw TypeError (500 instead of 400).
	if (!isOptionalString(body.key) || !isOptionalString(body.prefix)) {
		return jsonError(400, "bad_request", "key and prefix must be strings");
	}
	if (!isOptionalString(body.cursor)) {
		return jsonError(400, "bad_request", "cursor must be a string");
	}
	if (body.maxKeys !== undefined && !isPageSize(body.maxKeys)) {
		return jsonError(400, "bad_request", "maxKeys must be 1 to 1000");
	}
	const op = typeof body.op === "string" ? body.op : "";
	if (WRITE_OPS.has(op) && record.role !== EShareRole.ReadWrite) {
		return jsonError(403, "read_only", "This share token is read-only");
	}

	const storage = (await env.SHARE_TOKENS.get(
		storageKey(record.shareId),
		"json",
	)) as ShareStorage | null;
	if (!storage) {
		return jsonError(
			503,
			"storage_not_registered",
			"The share owner has not connected this share to the relay yet",
		);
	}
	try {
		if (op === "list") {
			const url = await presignS3(
				storage,
				"GET",
				"",
				PRESIGN_TTL_SECONDS,
				listQuery(
					shareListPrefix(
						storage.prefix,
						record.shareId,
						(body.prefix as string | undefined) ?? "",
					),
					body.cursor as string | undefined,
					body.maxKeys as number | undefined,
				),
			);
			return json({
				url,
				method: "GET",
				base: shareBasePrefix(storage.prefix, record.shareId),
			});
		}

		const method = objectMethod(op);
		if (!method) return jsonError(400, "bad_request", `Unknown op "${op}"`);
		const url = await presignS3(
			storage,
			method,
			shareObjectKey(
				storage.prefix,
				record.shareId,
				(body.key as string | undefined) ?? "",
			),
			PRESIGN_TTL_SECONDS,
		);
		return json({ url, method });
	} catch (err) {
		if (err instanceof InvalidShareKeyError) {
			return jsonError(400, "invalid_key", err.message);
		}
		throw err;
	}
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isPageSize(value: unknown): boolean {
	return (
		Number.isInteger(value) &&
		(value as number) >= 1 &&
		(value as number) <= MAX_PAGE_SIZE
	);
}

function objectMethod(op: string): PresignMethod | null {
	switch (op) {
		case "get":
			return "GET";
		case "put":
			return "PUT";
		case "delete":
			return "DELETE";
		case "head":
			return "HEAD";
		default:
			return null;
	}
}

function listQuery(
	prefix: string,
	cursor: string | undefined,
	maxKeys: number | undefined,
): Record<string, string> {
	const query: Record<string, string> = { "list-type": "2", prefix };
	if (cursor) query["continuation-token"] = cursor;
	if (maxKeys) query["max-keys"] = String(maxKeys);
	return query;
}

/* -------------------------------------------------------------------- admin */

async function registerShare(
	request: Request,
	env: ShareEnv,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	if (!isValidShareId(shareId)) {
		return jsonError(400, "bad_request", "Invalid shareId");
	}
	const storage = readShareStorage(await readJsonObject(request));
	if (!storage) return jsonError(400, "bad_request", "Invalid share storage");

	const key = storageKey(shareId);
	const next = JSON.stringify(storage);
	// The plugin re-registers on every start, and KV's free tier allows 1k writes a day.
	if ((await env.SHARE_TOKENS.get(key)) !== next) {
		await env.SHARE_TOKENS.put(key, next);
	}
	return json({ registered: true });
}

/** Revokes before forgetting the storage, so no token outlives the share. */
async function endShare(
	request: Request,
	env: ShareEnv,
	shareId: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	if (!isValidShareId(shareId)) {
		return jsonError(400, "bad_request", "Invalid shareId");
	}
	let revoked = 0;
	for (const participantId of await participantIds(env, shareId)) {
		if (await revokeParticipant(env, shareId, participantId)) revoked++;
	}
	await env.SHARE_TOKENS.delete(storageKey(shareId));
	return json({ revoked });
}

async function issueToken(request: Request, env: ShareEnv): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	const body = await readJsonObject(request);
	if (!body) return jsonError(400, "bad_request", "Invalid JSON body");
	if (
		typeof body.shareId !== "string" ||
		typeof body.participantId !== "string"
	) {
		return jsonError(400, "bad_request", "shareId and participantId required");
	}
	if (
		!body.participantId ||
		body.participantId.length > MAX_PARTICIPANT_ID_LENGTH ||
		!isValidShareId(body.shareId)
	) {
		return jsonError(400, "bad_request", "Invalid shareId or participantId");
	}

	const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
	const record: TokenRecord = {
		shareId: body.shareId,
		participantId: body.participantId,
		role:
			body.role === EShareRole.ReadOnly
				? EShareRole.ReadOnly
				: EShareRole.ReadWrite,
		label: typeof body.label === "string" ? body.label : undefined,
		createdAt: Date.now(),
	};
	const pointer = pointerKey(record.shareId, record.participantId);
	// Re-inviting replaces a person's token, so the previous one must be destroyed to avoid leaving unrevocable tokens.
	const previous = await env.SHARE_TOKENS.get(pointer);
	await env.SHARE_TOKENS.put(`tok:${token}`, JSON.stringify(record));
	await env.SHARE_TOKENS.put(pointer, token);
	if (previous && previous !== token) {
		await dropToken(env, previous);
	}
	return json({ token, ...record });
}

async function listTokens(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	const shareId = url.searchParams.get("shareId");
	if (!shareId) return jsonError(400, "bad_request", "shareId required");
	if (!isValidShareId(shareId)) {
		return jsonError(400, "bad_request", "Invalid shareId");
	}
	const ids = await participantIds(env, shareId);
	const participants = await Promise.all(
		ids.map(async (participantId) => {
			const token = await env.SHARE_TOKENS.get(
				pointerKey(shareId, participantId),
			);
			const record = token
				? ((await env.SHARE_TOKENS.get(
						`tok:${token}`,
						"json",
					)) as TokenRecord | null)
				: null;
			return { participantId, label: record?.label ?? "", role: record?.role };
		}),
	);
	return json({ participants });
}

async function revokeToken(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	let participantId: string;
	try {
		participantId = decodeURIComponent(url.pathname.slice(TOKENS_PATH.length));
	} catch {
		return jsonError(400, "bad_request", "Invalid participantId");
	}
	const shareId = url.searchParams.get("shareId");
	if (!shareId || !participantId) {
		return jsonError(400, "bad_request", "shareId and participantId required");
	}
	return json({
		revoked: await revokeParticipant(env, shareId, participantId),
	});
}

/* ------------------------------------------------------------------- helpers */

async function participantIds(
	env: ShareEnv,
	shareId: string,
): Promise<string[]> {
	const prefix = pointerKey(shareId, "");
	const ids: string[] = [];
	let cursor: string | undefined;
	// KV lists max 1000 keys per call; must paginate to avoid silent truncation.
	do {
		const listed = await env.SHARE_TOKENS.list({ prefix, cursor });
		for (const entry of listed.keys) ids.push(entry.name.slice(prefix.length));
		cursor = listed.list_complete ? undefined : listed.cursor;
	} while (cursor);
	return ids;
}

async function revokeParticipant(
	env: ShareEnv,
	shareId: string,
	participantId: string,
): Promise<boolean> {
	const pointer = pointerKey(shareId, participantId);
	const token = await env.SHARE_TOKENS.get(pointer);
	await env.SHARE_TOKENS.delete(pointer);
	if (!token) return false;
	await dropToken(env, token);
	return true;
}

/** An open hub socket outlives the KV record it was admitted with, so its channel is cut as well. */
async function dropToken(env: ShareEnv, token: string): Promise<void> {
	await env.SHARE_TOKENS.delete(`tok:${token}`);
	await hubStub(env).dropGrant(await fingerprint(token));
}

function readToken(
	request: Request,
	env: ShareEnv,
): Promise<TokenRecord | null> {
	const token = bearerOf(request);
	return token ? shareGrantOf(env, token) : Promise.resolve(null);
}

function bearerOf(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	return header.slice("Bearer ".length).trim() || null;
}

/** Extra fields are dropped, so a registration stores exactly what signing reads. */
function readShareStorage(body: JsonObject | null): ShareStorage | null {
	if (!body) return null;
	for (const field of REQUIRED_STORAGE_FIELDS) {
		if (typeof body[field] !== "string" || !body[field]) return null;
	}
	if (typeof body.region !== "string" || typeof body.prefix !== "string") {
		return null;
	}
	if (typeof body.forcePathStyle !== "boolean") return null;
	if (!URL.canParse(body.endpoint as string)) return null;
	return {
		endpoint: body.endpoint as string,
		region: body.region || "auto",
		bucket: body.bucket as string,
		prefix: body.prefix,
		accessKeyId: body.accessKeyId as string,
		secretAccessKey: body.secretAccessKey as string,
		forcePathStyle: body.forcePathStyle,
	};
}

async function readJsonObject(request: Request): Promise<JsonObject | null> {
	try {
		// `null` is valid JSON, so the shape has to be checked before it is read.
		const parsed: unknown = await request.json();
		return parsed && typeof parsed === "object" ? (parsed as JsonObject) : null;
	} catch {
		return null;
	}
}

function isValidShareId(shareId: string): boolean {
	try {
		shareBasePrefix("", shareId);
		return true;
	} catch {
		return false;
	}
}

function storageKey(shareId: string): string {
	return `storage:${shareId}`;
}

function pointerKey(shareId: string, participantId: string): string {
	return `pt:${shareId}:${participantId}`;
}

function adminUnauthorized(): Response {
	return jsonError(401, "unauthorized", "Invalid relay secret");
}

function methodNotAllowed(allow: string): Response {
	return new Response(
		JSON.stringify({
			error: "method_not_allowed",
			message: `Allowed: ${allow}`,
		}),
		{ status: 405, headers: { ...JSON_HEADERS, Allow: allow } },
	);
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function jsonError(status: number, code: string, message: string): Response {
	return json({ error: code, message }, status);
}
