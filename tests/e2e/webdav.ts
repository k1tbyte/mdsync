/**
 * An in-memory WebDAV server with what the plugin's adapter speaks, so two Obsidians share one storage;
 * auth is accepted as is.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface WebDav {
	url: string;
	stop(): void;
}

interface Stored {
	body: Buffer;
	etag: string;
}

export async function startWebDav(port: number): Promise<WebDav> {
	const files = new Map<string, Stored>();
	const dirs = new Set<string>(["/"]);

	const server: Server = createServer(async (req, res) => {
		const path = decodeURIComponent(
			new URL(req.url ?? "/", "http://x").pathname,
		);
		const file = files.get(path);
		const handlers: Record<string, () => Promise<void> | void> = {
			GET: () => {
				if (!file) return void res.writeHead(404).end();
				if (req.headers["if-none-match"] === file.etag) {
					return void res.writeHead(304).end();
				}
				res.writeHead(200, { ETag: file.etag }).end(file.body);
			},
			HEAD: () => void res.writeHead(file ? 200 : 404).end(),
			PUT: async () => {
				if (req.headers["if-none-match"] === "*" && file) {
					return void res.writeHead(412).end();
				}
				const body = await read(req);
				const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
				files.set(path, { body, etag });
				res.writeHead(file ? 204 : 201, { ETag: etag }).end();
			},
			DELETE: () => {
				const existed = files.delete(path);
				res.writeHead(existed ? 204 : 404).end();
			},
			MKCOL: () => {
				const dir = withSlash(path);
				if (dirs.has(dir)) return void res.writeHead(405).end();
				dirs.add(dir);
				res.writeHead(201).end();
			},
			PROPFIND: () => {
				const dir = withSlash(path);
				if (!dirs.has(dir)) return void res.writeHead(404).end();
				res
					.writeHead(207, { "Content-Type": "application/xml" })
					.end(listing(dir, [...files.keys()], [...dirs]));
			},
		};
		const handler = handlers[req.method ?? ""];
		if (handler) await handler();
		else res.writeHead(405).end();
	});
	await new Promise<void>((resolve) =>
		server.listen(port, "127.0.0.1", resolve),
	);
	return {
		url: `http://127.0.0.1:${port}`,
		stop: () => server.close(),
	};
}

function listing(dir: string, files: string[], dirs: string[]): string {
	const children = [
		...dirs
			.filter((d) => d !== dir && parentOf(d) === dir)
			.map((d) => entry(d, true)),
		...files.filter((f) => parentOf(f) === dir).map((f) => entry(f, false)),
	];
	return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entry(dir, true)}${children.join("")}</d:multistatus>`;
}

function entry(path: string, collection: boolean): string {
	const type = collection ? "<d:collection/>" : "";
	return `<d:response><d:href>${encodeURI(path)}</d:href><d:propstat><d:prop><d:resourcetype>${type}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function parentOf(path: string): string {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
}

function withSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

function read(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
