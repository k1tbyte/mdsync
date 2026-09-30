import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

import wrangler from "../../wrangler.toml?raw";

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const COMPATIBILITY_DATE = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(
	wrangler,
)?.[1];
const HUB_CLASS = /class_name\s*=\s*"([^"]+)"/.exec(wrangler)?.[1];
const TMP_REMOVAL_GRACE_MS = 500;

export interface Worker {
	url: string;
	stop(): Promise<void>;
}

let bundle: Promise<string> | undefined;

function bundled(): Promise<string> {
	bundle ??= build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		mainFields: ["module", "main"],
		target: "es2022",
		external: ["cloudflare:workers"],
		logLevel: "silent",
	}).then(({ outputFiles }) => outputFiles[0]?.text ?? "");
	return bundle;
}

export async function startWorker(
	vars: Record<string, string>,
): Promise<Worker> {
	const miniflare = new Miniflare(
		convertV4MiniflareOptions({
			modules: [
				{ type: "ESModule", path: "worker.js", contents: await bundled() },
			],
			compatibilityDate: COMPATIBILITY_DATE,
			durableObjects: { HUB: { className: HUB_CLASS ?? "", useSQLite: true } },
			kvNamespaces: ["SHARE_TOKENS"],
			bindings: vars,
			logRequests: false,
			port: 0,
		}),
	);
	const url = String(await miniflare.ready).replace(/\/$/, "");
	return {
		url,
		stop: async () => {
			await miniflare.dispose();
			await new Promise((resolve) => setTimeout(resolve, TMP_REMOVAL_GRACE_MS));
		},
	};
}
