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

import {
	endShare,
	issueToken,
	listTokens,
	registerShare,
	revokeToken,
} from "./share-admin";
import {
	badRequest,
	bearerOf,
	type JsonObject,
	json,
	jsonError,
	methodNotAllowed,
	readJsonObject,
} from "./share-http";
import {
	InvalidShareKeyError,
	shareBasePrefix,
	shareListPrefix,
	shareObjectKey,
} from "./share-key";
import {
	EShareRole,
	readStorage,
	revokeHeldToken,
	type ShareEnv,
	type ShareStorage,
	shareGrantOf,
} from "./share-kv";
import { type PresignMethod, presignS3 } from "./sigv4";

interface SignFields {
	key?: string;
	prefix?: string;
	cursor?: string;
	maxKeys?: number;
}

const PRESIGN_TTL_SECONDS = 120;
/** S3's own ceiling for one ListObjectsV2 page. */
const MAX_PAGE_SIZE = 1000;
const WRITE_OPS = new Set(["put", "delete"]);
const OBJECT_METHODS = new Map<string, PresignMethod>([
	["get", "GET"],
	["put", "PUT"],
	["delete", "DELETE"],
	["head", "HEAD"],
]);
const SHARES_PATH = "/share/shares/";
const TOKENS_PATH = "/share/tokens/";

/** Returns null when the path is not a broker route, so index.ts can fall through. */
export async function handleShareRequest(
	request: Request,
	env: ShareEnv,
	url: URL,
): Promise<Response | null> {
	const { pathname } = url;
	if (!pathname.startsWith("/share/")) return null;

	const shareId = url.searchParams.get("shareId") ?? "";
	if (pathname === "/share/sign") {
		if (request.method !== "POST") return methodNotAllowed("POST");
		return signObject(request, env);
	}
	if (pathname.startsWith(SHARES_PATH)) {
		const id = pathname.slice(SHARES_PATH.length);
		if (request.method === "PUT") return registerShare(request, env, id);
		if (request.method === "DELETE") return endShare(request, env, id);
		return methodNotAllowed("DELETE, PUT");
	}
	if (pathname === "/share/tokens") {
		if (request.method === "POST") return issueToken(request, env);
		if (request.method === "GET") return listTokens(request, env, shareId);
		return methodNotAllowed("GET, POST");
	}
	if (pathname === "/share/token") {
		if (request.method !== "DELETE") return methodNotAllowed("DELETE");
		return leaveShare(request, env);
	}
	if (pathname.startsWith(TOKENS_PATH)) {
		if (request.method !== "DELETE") return methodNotAllowed("DELETE");
		const participantId = pathname.slice(TOKENS_PATH.length);
		return revokeToken(request, env, participantId, shareId);
	}
	return jsonError(404, "not_found", "Unknown broker route");
}

async function leaveShare(request: Request, env: ShareEnv): Promise<Response> {
	const token = bearerOf(request);
	const record = await shareGrantOf(env, token);
	if (!record) return json({ revoked: false });
	await revokeHeldToken(env, token, record);
	return json({ revoked: true });
}

async function signObject(request: Request, env: ShareEnv): Promise<Response> {
	const record = await shareGrantOf(env, bearerOf(request));
	if (!record) return jsonError(401, "unauthorized", "Invalid share token");

	const body = await readJsonObject(request);
	if (!body) return badRequest("Invalid JSON body");
	const invalid = invalidSignFields(body);
	if (invalid) return badRequest(invalid);

	const op = typeof body.op === "string" ? body.op : "";
	if (WRITE_OPS.has(op) && record.role !== EShareRole.ReadWrite) {
		return jsonError(403, "read_only", "This share token is read-only");
	}
	const storage = await readStorage(env, record.shareId);
	if (!storage) {
		return jsonError(
			503,
			"storage_not_registered",
			"The share owner has not connected this share to the relay yet",
		);
	}
	const fields = body as SignFields;
	try {
		return op === "list"
			? await presignList(storage, record.shareId, fields)
			: await presignObject(storage, record.shareId, op, fields);
	} catch (err) {
		if (err instanceof InvalidShareKeyError) {
			return jsonError(400, "invalid_key", err.message);
		}
		throw err;
	}
}

async function presignList(
	storage: ShareStorage,
	shareId: string,
	{ prefix = "", cursor, maxKeys }: SignFields,
): Promise<Response> {
	const url = await presignS3(
		storage,
		"GET",
		"",
		PRESIGN_TTL_SECONDS,
		listQuery(
			shareListPrefix(storage.prefix, shareId, prefix),
			cursor,
			maxKeys,
		),
	);
	return json({
		url,
		method: "GET",
		base: shareBasePrefix(storage.prefix, shareId),
	});
}

async function presignObject(
	storage: ShareStorage,
	shareId: string,
	op: string,
	{ key = "" }: SignFields,
): Promise<Response> {
	const method = OBJECT_METHODS.get(op);
	if (!method) return badRequest(`Unknown op "${op}"`);
	const url = await presignS3(
		storage,
		method,
		shareObjectKey(storage.prefix, shareId, key),
		PRESIGN_TTL_SECONDS,
	);
	return json({ url, method });
}

/** Fields are participant-controlled: a number reaching assertSafeKey would throw TypeError (500 instead of 400). */
function invalidSignFields(body: JsonObject): string | null {
	if (!isOptionalString(body.key) || !isOptionalString(body.prefix)) {
		return "key and prefix must be strings";
	}
	if (!isOptionalString(body.cursor)) return "cursor must be a string";
	if (body.maxKeys !== undefined && !isPageSize(body.maxKeys)) {
		return "maxKeys must be 1 to 1000";
	}
	return null;
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
