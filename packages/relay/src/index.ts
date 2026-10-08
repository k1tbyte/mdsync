import {
	type GoogleOAuthEnv,
	handleAuthCallback,
	handleTokenRefresh,
} from "./google-oauth";
import { handleHubRequest } from "./hub/access";
import { Hub } from "./hub/durable-object";
import { Link } from "./link/durable-object";
import { handleLinkRequest } from "./link/routes";
import { handleShellRequest, type ShellEnv } from "./link/shell";
import type { LinkEnv } from "./link/stub";
import { ADMIN_HEADER, isAdmin } from "./secret";
import { handleShareRequest } from "./share/broker";
import type { ShareEnv } from "./share/kv";

export interface Env extends ShareEnv, GoogleOAuthEnv, LinkEnv, ShellEnv {}

export { Hub, Link };

const CORS_PREFLIGHT_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": `Content-Type, Authorization, ${ADMIN_HEADER}`,
} as const;

const NOT_FOUND =
	"Not found. Use /hub for realtime sync, /share/* for shared folders, /link/* for share links, or /auth for Google Drive.";

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_PREFLIGHT_HEADERS });
		}

		const url = new URL(request.url);
		if (url.pathname === "/status") return status(request, env);

		const shareResponse = await handleShareRequest(request, env, url);
		if (shareResponse) return shareResponse;

		const shellResponse = await handleShellRequest(request, env, url);
		if (shellResponse) return shellResponse;

		const linkResponse = await handleLinkRequest(request, env, url);
		if (linkResponse) return linkResponse;

		const hubResponse = await handleHubRequest(request, env, url);
		if (hubResponse) return hubResponse;

		if (url.pathname === "/refresh") return handleTokenRefresh(request, env);
		if (url.pathname === "/auth") {
			return handleAuthCallback(url, env, request);
		}
		return new Response(NOT_FOUND, { status: 404 });
	},
};

/** Lets the plugin tell a wrong URL (no answer) from a wrong secret (401). */
async function status(request: Request, env: Env): Promise<Response> {
	if (!(await isAdmin(request, env))) {
		return Response.json(
			{ error: "unauthorized", message: "Invalid relay secret" },
			{ status: 401 },
		);
	}
	return Response.json({ ok: true });
}
