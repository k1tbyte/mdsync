#!/usr/bin/env node
/**
 * Prototype of the in-plugin Cloudflare setup, run from Node against a real account:
 * deploys the relay and creates the R2 vault storage through `packages/plugin/src/cloudflare`.
 *
 *   CLOUDFLARE_API_TOKEN=... node tools/cloudflare-setup.mjs [--no-relay] [--no-r2] [--show-secrets]
 *
 * Optional env: CLOUDFLARE_ACCOUNT_ID, RELAY_SECRET (required to update an existing relay),
 * MDSYNC_RELAY_NAME (worker name, default from wrangler.toml), MDSYNC_SUBDOMAIN (workers.dev name for
 * an account without one), MDSYNC_BUCKET (default mdsync-vault).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));

// The plugin's crypto reads window.crypto, as in Obsidian.
globalThis.window ??= globalThis;
const { cf, signer, base64 } = await load();

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
	console.error(
		`Set CLOUDFLARE_API_TOKEN. Create one here:\n${cf.tokenTemplateUrl()}`,
	);
	process.exit(1);
}

const api = cf.cloudflareApi(async (req) => {
	const res = await fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body,
	});
	return { status: res.status, text: await res.text() };
}, token);

const accounts = await step("accounts", () => cf.listAccounts(api));
const wanted = process.env.CLOUDFLARE_ACCOUNT_ID;
const account = wanted ? accounts.find((a) => a.id === wanted) : accounts[0];
if (!account) {
	throw new Error(
		wanted
			? `The token does not reach account ${wanted}.`
			: "The token reaches no account.",
	);
}
if (accounts.length > 1) {
	console.log(`  ${accounts.map((a) => `${a.id} ${a.name}`).join("\n  ")}`);
}
console.log(`  using ${account.name} (${account.id})`);
const tokenId = await step("token", () => cf.verifyToken(api, account.id));

const shown = (value) =>
	args.has("--show-secrets") ? value : `${value.slice(0, 4)}…`;

if (!args.has("--no-relay")) await relay();
if (!args.has("--no-r2")) await r2();

async function relay() {
	// Through the shell: pnpm is a .cmd shim on Windows.
	execSync("pnpm --filter mdsync-relay run bundle", {
		cwd: root,
		stdio: "ignore",
	});
	const bundle = JSON.parse(
		readFileSync(`${root}packages/relay/dist/relay-bundle.json`, "utf8"),
	);
	bundle.name = process.env.MDSYNC_RELAY_NAME ?? bundle.name;
	const scripts = await api.call(
		"GET",
		`/accounts/${account.id}/workers/scripts`,
	);
	// A new secret on a live relay would lock out every device configured with the old one.
	if (!process.env.RELAY_SECRET && scripts.some((s) => s.id === bundle.name)) {
		throw new Error(
			`${bundle.name} already runs here: pass its RELAY_SECRET or pick another MDSYNC_RELAY_NAME.`,
		);
	}
	const secret =
		process.env.RELAY_SECRET ??
		base64.bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const url = await step("deploy relay", () =>
		cf.deployRelay({
			api,
			accountId: account.id,
			bundle,
			secret,
			proposeSubdomain: () =>
				process.env.MDSYNC_SUBDOMAIN ??
				`mdsync-${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex")}`,
			onStep: (s) => console.log(`  - ${s}`),
		}),
	);
	await step("relay answers /status", () =>
		until(async () => {
			const res = await fetch(`${url}/status`, {
				headers: { "X-Mdsync-Admin": secret },
			}).catch(() => null);
			return res?.status === 200;
		}, 300_000),
	);
	console.log(`  Relay URL: ${url}\n  Relay secret: ${shown(secret)}`);
}

async function r2() {
	const bucket = process.env.MDSYNC_BUCKET ?? "mdsync-vault";
	try {
		await step("R2 bucket", () => cf.ensureBucket(api, account.id, bucket));
	} catch (err) {
		if (!(err instanceof cf.R2NotEnabledError)) throw err;
		console.error(`  Enable R2 first: ${cf.r2DashboardUrl(account.id)}`);
		process.exitCode = 1;
		return;
	}
	const storage = await cf.r2Storage(account.id, bucket, tokenId, token);
	const sign = signer.createS3Signer({
		...storage,
		kind: "s3",
		prefix: "",
		forcePathStyle: true,
		concurrency: 4,
	});
	const s3 = async (method, key, body, headers) => {
		const req = await sign({
			method,
			key,
			body,
			headers,
			query: key ? undefined : { "list-type": "2", "max-keys": "1" },
		});
		return (await fetch(req.url, { method, headers: req.headers, body }))
			.status;
	};
	// New S3 credentials can take a few seconds to be accepted.
	await step("S3 list with derived keys", () =>
		until(async () => (await s3("GET", "")) === 200, 60_000),
	);
	// A fresh key written only if absent, so the probe never touches an existing object.
	const probe = `mdsync-setup-probe-${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`;
	await step("S3 write and delete", async () => {
		const put = await s3("PUT", probe, new TextEncoder().encode("ok"), {
			"If-None-Match": "*",
		});
		if (put !== 200) throw new Error(`PUT ${put}`);
		const del = await s3("DELETE", probe);
		if (del !== 204) throw new Error(`DELETE ${del}`);
	});
	console.log(
		`  Endpoint: ${storage.endpoint}\n  Bucket: ${bucket}\n  Access key ID: ${storage.accessKeyId}\n  Secret: ${shown(storage.secretAccessKey)}`,
	);
}

async function load() {
	const jiti = createJiti(import.meta.url, {
		alias: { "@/": `${root}packages/plugin/src/` },
	});
	return {
		cf: await jiti.import(`${root}packages/plugin/src/cloudflare/index.ts`),
		signer: await jiti.import(
			`${root}packages/plugin/src/storage/adapters/s3-signer.ts`,
		),
		base64: await jiti.import(`${root}packages/plugin/src/utils/base64.ts`),
	};
}

async function step(name, run) {
	const started = Date.now();
	process.stdout.write(`${name}…\n`);
	const result = await run();
	console.log(`  ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	return result;
}

async function until(check, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline)
			throw new Error(`Gave up after ${timeoutMs / 1000}s`);
		await new Promise((r) => setTimeout(r, 3_000));
	}
}
