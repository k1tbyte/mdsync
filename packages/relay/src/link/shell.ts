/** `/s/<id>`: the viewer's one HTML page, with the headers that keep a shared note inside its sandbox. */

import { isLinkId } from "@mdsync/protocol";

export interface ShellEnv {
	ASSETS: Fetcher;
}

const SHELL_PATH = /^\/s\/([^/]+)\/?$/;
/** Where the viewer's build lands inside the assets directory. */
const SHELL_ASSET = "/viewer/";

/**
 * Scripts and styles only from the relay itself; images from data: (the note's own) and https: (what its
 * author linked); no framing, no forms, no base tags.
 */
const POLICY = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"style-src-attr 'unsafe-inline'",
	"img-src data: https:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

/** Returns null when the path is not a link page, so index.ts can fall through. */
export async function handleShellRequest(
	request: Request,
	env: ShellEnv,
	url: URL,
): Promise<Response | null> {
	const match = SHELL_PATH.exec(url.pathname);
	if (!match) return null;
	if (!isLinkId(match[1] ?? "")) return notFound();
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	}
	const shell = await env.ASSETS.fetch(new URL(SHELL_ASSET, url));
	if (!shell.ok) {
		return new Response("The link viewer is not deployed on this relay.", {
			status: 503,
		});
	}
	const headers = new Headers(shell.headers);
	headers.set("Content-Security-Policy", POLICY);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Robots-Tag", "noindex, nofollow");
	headers.set("Cache-Control", "no-cache");
	return new Response(request.method === "HEAD" ? null : shell.body, {
		status: 200,
		headers,
	});
}

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}
