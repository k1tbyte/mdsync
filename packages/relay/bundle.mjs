// Builds the relay as one JSON the plugin can upload through the Cloudflare API (see RelayBundle).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";

const root = fileURLToPath(new URL(".", import.meta.url));
const out = join(root, "dist");
const workerDir = join(out, "worker");

// What wrangler serves these as. Text only: the plugin carries the files readable, not as opaque blobs.
const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
};

const config = unstable_readConfig({ config: join(root, "wrangler.toml") });
// Through the shell: pnpm is a .cmd shim on Windows.
execSync("pnpm exec wrangler deploy --dry-run --outdir dist/worker", {
	cwd: root,
	stdio: "inherit",
});

const assetsDir = resolve(root, config.assets.directory);
const files = walk(assetsDir).map((path) => {
	const ext = extname(path);
	const type = TYPES[ext];
	if (!type) throw new Error(`No text type for relay asset ${path}`);
	const bytes = readFileSync(path);
	return {
		path: `/${relative(assetsDir, path).split("\\").join("/")}`,
		// Cloudflare skips a hash it holds and keeps that file's type, so the type is hashed too.
		hash: sha256(`${type}\n${bytes.toString("base64")}`).slice(0, 32),
		size: bytes.length,
		type,
		text: bytes.toString("utf8"),
	};
});

const content = {
	name: config.name,
	mainModule: "index.js",
	worker: readFileSync(join(workerDir, "index.js"), "utf8"),
	compatibilityDate: config.compatibility_date,
	compatibilityFlags: config.compatibility_flags,
	kvBindings: config.kv_namespaces.map((kv) => kv.binding),
	durableObjects: config.durable_objects.bindings.map((d) => ({
		name: d.name,
		className: d.class_name,
	})),
	migrations: config.migrations,
	assets: {
		binding: config.assets.binding,
		runWorkerFirst: config.assets.run_worker_first,
		files,
	},
};
const bundle = {
	...content,
	version: sha256(JSON.stringify(content)).slice(0, 12),
};

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "relay-bundle.json"), JSON.stringify(bundle));
console.log(
	`relay-bundle.json: ${bundle.version}, worker ${bundle.worker.length} B, ${files.length} assets`,
);

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}
