/**
 * Share link routes. The owner's plugin stores, updates, inspects and revokes behind the relay secret;
 * the viewer asks `meta` and then `open`. The relay only ever holds sealed bytes.
 */

import {
	isLinkId,
	LINK_GATE_PATTERN,
	LINK_HEADERS,
	LINK_MAX_SEALED_BYTES,
	LINK_MAX_TTL_S,
	LINK_MAX_VIEWS,
} from "@mdsync/protocol";

import { fingerprint, isAdmin, type SecretEnv } from "../secret";
import {
	adminUnauthorized,
	badRequest,
	json,
	jsonError,
	methodNotAllowed,
	readJsonObject,
} from "../share/http";
import { clientOf } from "./client";
import type { LinkSettings } from "./store";
import { type LinkEnv, linkStub } from "./stub";

export interface LinkRouteEnv extends SecretEnv, LinkEnv {}

const ROUTE = /^\/link\/([^/]+)(?:\/(meta|status|open))?$/;
const SALT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** Longer than any real gate; the cap only keeps a hostile body from being hashed. */
const MAX_PRESENTED_GATE = 64;
const GONE_TEXT = "This link has expired or reached its view limit.";

/** Returns null when the path is not a link route, so index.ts can fall through. */
export async function handleLinkRequest(
	request: Request,
	env: LinkRouteEnv,
	url: URL,
): Promise<Response | null> {
	if (!url.pathname.startsWith("/link/")) return null;
	const match = ROUTE.exec(url.pathname);
	const id = match?.[1] ?? "";
	if (!match || !isLinkId(id))
		return jsonError(404, "not_found", "Unknown link route");
	const { method } = request;

	switch (match[2]) {
		case undefined:
			if (method === "PUT") return storeLink(request, env, id, url);
			if (method === "DELETE") return revokeLink(request, env, id);
			return methodNotAllowed("DELETE, PUT");
		case "status":
			return method === "GET"
				? linkStatus(request, env, id)
				: methodNotAllowed("GET");
		case "meta":
			return method === "GET" ? linkMeta(env, id) : methodNotAllowed("GET");
		default:
			return method === "POST"
				? openLink(request, env, id)
				: methodNotAllowed("POST");
	}
}

async function storeLink(
	request: Request,
	env: LinkRouteEnv,
	id: string,
	url: URL,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	const settings = await readSettings(request, url);
	if (typeof settings === "string") return badRequest(settings);
	if (Number(request.headers.get("Content-Length")) > LINK_MAX_SEALED_BYTES) {
		return tooLarge();
	}
	const blob = await request.arrayBuffer();
	if (blob.byteLength > LINK_MAX_SEALED_BYTES) return tooLarge();
	if (blob.byteLength === 0) return badRequest("The body is empty");
	const mode = url.searchParams.get("update") === "1" ? "update" : "create";
	const stored = await linkStub(env, id).put(blob, settings, mode);
	if (stored === "gone") return gone();
	if (stored === "exists") {
		return fresh(
			jsonError(409, "exists", "A link with this id already exists"),
		);
	}
	return fresh(json({ stored: true, size: blob.byteLength }));
}

async function revokeLink(
	request: Request,
	env: LinkRouteEnv,
	id: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	await linkStub(env, id).revoke();
	return fresh(json({ revoked: true }));
}

async function linkStatus(
	request: Request,
	env: LinkRouteEnv,
	id: string,
): Promise<Response> {
	if (!(await isAdmin(request, env))) return adminUnauthorized();
	const status = await linkStub(env, id).status();
	return status ? fresh(json(status)) : gone();
}

/** Counts nothing, so the viewer can learn whether to ask for a passphrase without spending a view. */
async function linkMeta(env: LinkRouteEnv, id: string): Promise<Response> {
	const meta = await linkStub(env, id).meta();
	return meta ? fresh(json(meta)) : gone();
}

async function openLink(
	request: Request,
	env: LinkRouteEnv,
	id: string,
): Promise<Response> {
	const body = await readJsonObject(request);
	const presented =
		typeof body?.gate === "string" && body.gate.length <= MAX_PRESENTED_GATE
			? await fingerprint(body.gate)
			: null;
	const result = await linkStub(env, id).open(
		presented,
		await clientOf(request),
	);
	if (result.ok) {
		const headers = new Headers({
			"Content-Type": "application/octet-stream",
			"Cache-Control": "no-store",
		});
		if (result.viewsLeft !== null) {
			headers.set(LINK_HEADERS.viewsLeft, String(result.viewsLeft));
		}
		if (result.expires !== null) {
			headers.set(LINK_HEADERS.expires, String(result.expires));
		}
		return new Response(result.blob, { headers });
	}
	if (result.reason === "gone") return gone();
	const response = jsonError(
		result.reason === "gate" ? 401 : 429,
		result.reason,
		result.reason === "gate"
			? "Wrong passphrase."
			: "Too many wrong passphrases.",
	);
	if (result.retryAfter !== null) {
		response.headers.set("Retry-After", String(result.retryAfter));
	}
	return fresh(response);
}

/** A string is the reason the request is refused. */
async function readSettings(
	request: Request,
	url: URL,
): Promise<LinkSettings | string> {
	const now = Math.floor(Date.now() / 1000);
	const maxViews = optionalInt(
		url.searchParams.get("maxViews"),
		1,
		LINK_MAX_VIEWS,
	);
	const expires = optionalInt(
		url.searchParams.get("expires"),
		now + 1,
		now + LINK_MAX_TTL_S,
	);
	if (maxViews === "invalid") return "Invalid maxViews";
	if (expires === "invalid") return "Invalid expires";
	const gate = request.headers.get(LINK_HEADERS.gate);
	const salt = request.headers.get(LINK_HEADERS.salt);
	if ((gate === null) !== (salt === null))
		return "A passphrase needs a gate and a salt";
	if (gate !== null && salt !== null) {
		if (!LINK_GATE_PATTERN.test(gate) || !SALT_PATTERN.test(salt)) {
			return "Invalid gate or salt";
		}
		return { maxViews, expires, gate: await fingerprint(gate), salt };
	}
	return { maxViews, expires, gate: null, salt: null };
}

function optionalInt(
	text: string | null,
	min: number,
	max: number,
): number | null | "invalid" {
	if (text === null || text === "") return null;
	const value = Number(text);
	return Number.isInteger(value) && value >= min && value <= max
		? value
		: "invalid";
}

function gone(): Response {
	return fresh(jsonError(404, "gone", GONE_TEXT));
}

function tooLarge(): Response {
	return jsonError(
		413,
		"too_large",
		"The note is too large to share as a link",
	);
}

function fresh(response: Response): Response {
	response.headers.set("Cache-Control", "no-store");
	return response;
}
