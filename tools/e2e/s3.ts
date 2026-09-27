/**
 * An in-memory, path-style S3 with just what the plugin's adapter speaks:
 * object GET/HEAD/PUT/DELETE, conditional reads and writes, ListObjectsV2.
 * Signatures are accepted as is; only a revoked access key is refused.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface S3 {
	url: string;
	bucket: string;
	/** Object keys, for checks on where things were written. */
	keys(): string[];
	/** Refuses the access key from now on, as a deleted S3 key would be. */
	revoke(accessKeyId: string): void;
	stop(): void;
}

interface Stored {
	body: Buffer;
	etag: string;
}

const BUCKET = "e2e";
const NO_SUCH_KEY = "<Error><Code>NoSuchKey</Code></Error>";

export async function startS3(port: number): Promise<S3> {
	const objects = new Map<string, Stored>();
	const revoked = new Set<string>();

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (revoked.has(accessKeyOf(req, url))) {
			return void res.writeHead(403).end();
		}
		const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
		if (bucket !== BUCKET) return void res.writeHead(404).end();
		const key = rest.join("/");
		const found = objects.get(key);
		const missing = () =>
			void res
				.writeHead(404, { "Content-Type": "application/xml" })
				.end(NO_SUCH_KEY);
		const handlers: Record<string, () => Promise<void> | void> = {
			GET: () => {
				if (key === "") return list(url.searchParams);
				if (!found) return missing();
				if (req.headers["if-none-match"] === found.etag) {
					return void res.writeHead(304).end();
				}
				res.writeHead(200, { ETag: found.etag }).end(found.body);
			},
			HEAD: () => void res.writeHead(found ? 200 : 404).end(),
			PUT: async () => {
				if (req.headers["if-none-match"] === "*" && found) {
					return void res.writeHead(412).end();
				}
				const body = await read(req);
				const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
				objects.set(key, { body, etag });
				res.writeHead(200, { ETag: etag }).end();
			},
			DELETE: () => {
				objects.delete(key);
				res.writeHead(204).end();
			},
		};

		function list(query: URLSearchParams): void {
			const prefix = query.get("prefix") ?? "";
			const max = Number(query.get("max-keys") ?? 1000);
			const keys = [...objects.keys()]
				.filter((name) => name.startsWith(prefix))
				.sort();
			const from = Number(query.get("continuation-token") ?? 0);
			const page = keys.slice(from, from + max);
			const next = from + max < keys.length ? String(from + max) : null;
			const contents = page
				.map((name) => `<Contents><Key>${escapeXml(name)}</Key></Contents>`)
				.join("");
			const token =
				next === null
					? ""
					: `<NextContinuationToken>${next}</NextContinuationToken>`;
			res
				.writeHead(200, { "Content-Type": "application/xml" })
				.end(
					`<ListBucketResult><IsTruncated>${next !== null}</IsTruncated>${contents}${token}</ListBucketResult>`,
				);
		}

		const handler = handlers[req.method ?? ""];
		if (!handler) return void res.writeHead(405).end();
		await handler();
	});

	await new Promise<void>((resolve) => server.listen(port, resolve));
	return {
		url: `http://127.0.0.1:${port}`,
		bucket: BUCKET,
		keys: () => [...objects.keys()].sort(),
		revoke: (accessKeyId) => revoked.add(accessKeyId),
		stop: () => server.close(),
	};
}

/** From a presigned URL's query or a signed request's header. */
function accessKeyOf(req: IncomingMessage, url: URL): string {
	const credential =
		url.searchParams.get("X-Amz-Credential") ??
		/Credential=([^,]+)/.exec(req.headers.authorization ?? "")?.[1] ??
		"";
	return credential.split("/")[0] ?? "";
}

function read(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
