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
/** The open route is public and its body is one gate, so anything bigger is not parsed. */
const MAX_OPEN_BODY_BYTES = 1024;
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
	const parsed = await readSettings(request, url);
	if (!parsed.ok) return badRequest(parsed.reason);
	if (Number(request.headers.get("Content-Length")) > LINK_MAX_SEALED_BYTES) {
		return tooLarge();
	}
	const blob = await request.arrayBuffer();
	if (blob.byteLength > LINK_MAX_SEALED_BYTES) return tooLarge();
	if (blob.byteLength === 0) return badRequest("The body is empty");
	const mode = url.searchParams.get("update") === "1" ? "update" : "create";
	// On the relay's clock, so a device with the wrong time cannot misdate it, and after a slow upload.
	const expires =
		parsed.ttl === null ? null : Math.floor(Date.now() / 1000) + parsed.ttl;
	const settings = { ...parsed.settings, expires };
	const stored = await linkStub(env, id).put(blob, settings, mode);
	if (stored === "gone") return gone();
	if (stored === "mismatch") return fresh(wrongGate());
	if (stored === "exists") {
		return fresh(
			jsonError(409, "exists", "A link with this id already exists"),
		);
	}
	// An update keeps the limits it was created with, so only a creation has an expiry to report.
	return fresh(
		json({
			stored: true,
			size: blob.byteLength,
			...(mode === "create" && { expires: settings.expires }),
		}),
	);
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
	const body = await readJsonObject(request, MAX_OPEN_BODY_BYTES);
	const presented =
		typeof body?.gate === "string" && LINK_GATE_PATTERN.test(body.gate)
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
	const response =
		result.reason === "gate"
			? wrongGate(401)
			: jsonError(429, result.reason, "Too many wrong passphrases.");
	if (result.retryAfter !== null) {
		response.headers.set("Retry-After", String(result.retryAfter));
	}
	return fresh(response);
}

/** The expiry is a span, kept apart from the settings: it starts when the body has arrived, not before. */
async function readSettings(
	request: Request,
	url: URL,
): Promise<
	| { ok: true; settings: Omit<LinkSettings, "expires">; ttl: number | null }
	| { ok: false; reason: string }
> {
	const maxViews = optionalInt(
		url.searchParams.get("maxViews"),
		1,
		LINK_MAX_VIEWS,
	);
	const ttl = optionalInt(url.searchParams.get("ttl"), 1, LINK_MAX_TTL_S);
	const gate = request.headers.get(LINK_HEADERS.gate);
	const salt = request.headers.get(LINK_HEADERS.salt);
	if (maxViews === "invalid") return refused("Invalid maxViews");
	if (ttl === "invalid") return refused("Invalid ttl");
	if (gate === null || !LINK_GATE_PATTERN.test(gate)) {
		return refused("Invalid gate");
	}
	if (salt !== null && !SALT_PATTERN.test(salt)) return refused("Invalid salt");
	return {
		ok: true,
		ttl,
		settings: { maxViews, gate: await fingerprint(gate), salt },
	};
}

function refused(reason: string) {
	return { ok: false, reason } as const;
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

function wrongGate(status = 403): Response {
	return jsonError(status, "gate", "Wrong passphrase.");
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
