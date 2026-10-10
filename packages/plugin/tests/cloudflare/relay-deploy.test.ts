import {
	failure,
	fakeCloudflare,
	type Route,
	readForm,
} from "@tests/helpers/fake-cloudflare";
import { describe, expect, it, vi } from "vitest";
import {
	deployRelay,
	type HttpRequest,
	type RelayBundle,
	workerNames,
	workersSubdomain,
	workerUrl,
} from "@/cloudflare";

const A = "/accounts/acc";
const SCRIPT = `${A}/workers/scripts/mdsync-relay`;

const BUNDLE: RelayBundle = {
	name: "mdsync-relay",
	version: "v-hash",
	mainModule: "index.js",
	worker: "export default {}",
	compatibilityDate: "2026-09-14",
	compatibilityFlags: [],
	kvBindings: ["SHARE_TOKENS"],
	durableObjects: [{ name: "HUB", className: "Hub" }],
	migrations: [
		{ tag: "v1", new_sqlite_classes: ["Hub"] },
		{ tag: "v2", new_sqlite_classes: ["Link"] },
	],
	assets: {
		binding: "ASSETS",
		runWorkerFirst: ["/s/*"],
		files: [
			{
				path: "/viewer/index.html",
				hash: "a".repeat(32),
				size: 3,
				type: "text/html",
				text: "<b>",
			},
			{
				path: "/viewer/viewer.js",
				hash: "b".repeat(32),
				size: 1,
				type: "text/javascript",
				text: ";",
			},
		],
	},
};

const DEPLOY: Route[] = [
	{
		method: "PUT",
		path: SCRIPT,
		reply: () => ({ result: { id: "mdsync-relay" } }),
	},
	{
		method: "POST",
		path: `${SCRIPT}/subdomain`,
		reply: () => ({ result: { enabled: true } }),
	},
];

async function metadataOf(call: HttpRequest | undefined) {
	if (!call) throw new Error("no script upload");
	const form = await readForm(call);
	expect(await (form.get("index.js") as File).text()).toBe(BUNDLE.worker);
	return JSON.parse(form.get("metadata") as string);
}

describe("deployRelay", () => {
	it("deploys a fresh relay: subdomain, namespace, files, worker and route", async () => {
		let uploads = 0;
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10007, 404),
			},
			{
				method: "PUT",
				path: `${A}/workers/subdomain`,
				reply: (r) => ({ result: JSON.parse(r.body as string) }),
			},
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({ result: [] }),
			},
			{
				method: "GET",
				path: /storage\/kv\/namespaces\?/,
				reply: () => ({ result: [] }),
			},
			{
				method: "POST",
				path: `${A}/storage/kv/namespaces`,
				reply: () => ({ result: { id: "kv1" } }),
			},
			{
				method: "POST",
				path: `${SCRIPT}/assets-upload-session`,
				reply: () => ({
					result: {
						jwt: "upload",
						buckets: [["a".repeat(32)], ["b".repeat(32)]],
					},
				}),
			},
			{
				method: "POST",
				path: `${A}/workers/assets/upload?base64=true`,
				reply: () => ({
					status: ++uploads === 2 ? 201 : 200,
					result: uploads === 2 ? { jwt: "done" } : {},
				}),
			},
			...DEPLOY,
		]);

		const url = await deployRelay({
			api: cf.api,
			accountId: "acc",
			bundle: BUNDLE,
			secret: "s3cret",
			proposeSubdomain: () => "mdsync-x",
		});

		expect(url).toBe("https://mdsync-relay.mdsync-x.workers.dev");
		const kvCreate = cf.calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/kv/namespaces"),
		);
		expect(JSON.parse(kvCreate?.body as string)).toEqual({
			title: "mdsync-relay-share-tokens",
		});

		const assetCalls = cf.calls.filter((c) => c.url.includes("/assets/upload"));
		expect(assetCalls.map((c) => c.headers.Authorization)).toEqual([
			"Bearer upload",
			"Bearer upload",
		]);
		const first = await readForm(assetCalls[0] as HttpRequest);
		expect(await (first.get("a".repeat(32)) as File).text()).toBe("PGI+");

		const meta = await metadataOf(
			cf.calls.find(
				(c) => c.method === "PUT" && c.url.endsWith("mdsync-relay"),
			),
		);
		expect(meta.bindings).toEqual([
			{ type: "kv_namespace", name: "SHARE_TOKENS", namespace_id: "kv1" },
			{ type: "durable_object_namespace", name: "HUB", class_name: "Hub" },
			{ type: "assets", name: "ASSETS" },
			{ type: "plain_text", name: "RELAY_VERSION", text: "v-hash" },
			{ type: "secret_text", name: "RELAY_SECRET", text: "s3cret" },
		]);
		expect(meta.keep_bindings).toEqual(["secret_text"]);
		expect(meta.migrations).toEqual({
			new_tag: "v2",
			steps: [
				{ new_sqlite_classes: ["Hub"] },
				{ new_sqlite_classes: ["Link"] },
			],
		});
		expect(meta.assets).toEqual({
			jwt: "done",
			config: { run_worker_first: ["/s/*"] },
		});
		expect(JSON.parse(cf.calls.at(-1)?.body as string)).toEqual({
			enabled: true,
			previews_enabled: false,
		});
	});

	it("updates a deployed relay in place: its namespace, only new migrations, unchanged files", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({
					result: [{ id: "mdsync-relay", migration_tag: "v1" }],
				}),
			},
			{
				method: "GET",
				path: `${SCRIPT}/settings`,
				reply: () => ({
					result: {
						bindings: [
							{
								type: "kv_namespace",
								name: "SHARE_TOKENS",
								namespace_id: "kv-old",
							},
						],
					},
				}),
			},
			{
				method: "POST",
				path: `${SCRIPT}/assets-upload-session`,
				reply: () => ({ result: { jwt: "same", buckets: [] } }),
			},
			...DEPLOY,
		]);

		const url = await deployRelay({
			api: cf.api,
			accountId: "acc",
			bundle: BUNDLE,
			secret: "s3cret",
			proposeSubdomain: () => {
				throw new Error("must not register a subdomain");
			},
		});

		expect(url).toBe("https://mdsync-relay.me.workers.dev");
		expect(
			cf
				.paths()
				.some(
					(p) => p.includes("kv/namespaces") || p.includes("assets/upload"),
				),
		).toBe(false);
		const meta = await metadataOf(cf.calls.find((c) => c.method === "PUT"));
		expect(meta.bindings[0]).toEqual({
			type: "kv_namespace",
			name: "SHARE_TOKENS",
			namespace_id: "kv-old",
		});
		expect(meta.migrations).toEqual({
			old_tag: "v1",
			new_tag: "v2",
			steps: [{ new_sqlite_classes: ["Link"] }],
		});
		expect(meta.assets.jwt).toBe("same");
	});

	it("proposes another workers.dev name when one is taken", async () => {
		const names = ["taken", "free"];
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10007, 404),
			},
			{
				method: "PUT",
				path: `${A}/workers/subdomain`,
				reply: (r) =>
					JSON.parse(r.body as string).subdomain === "taken"
						? failure(10031, 409)
						: { result: { subdomain: "free" } },
			},
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({ result: [] }),
			},
			{
				method: "GET",
				path: /storage\/kv\/namespaces\?/,
				reply: () => ({
					result: [{ id: "kv9", title: "mdsync-relay-share-tokens" }],
				}),
			},
			{
				method: "POST",
				path: `${SCRIPT}/assets-upload-session`,
				reply: () => ({ result: { jwt: "j", buckets: [] } }),
			},
			...DEPLOY,
		]);

		const url = await deployRelay({
			api: cf.api,
			accountId: "acc",
			bundle: BUNDLE,
			secret: "s",
			proposeSubdomain: () => names.shift() ?? "none",
		});

		expect(url).toBe("https://mdsync-relay.free.workers.dev");
		expect(cf.paths()).not.toContain(`POST ${A}/storage/kv/namespaces`);
	});
});

const DEPLOYED: Route[] = [
	{
		method: "GET",
		path: `${A}/workers/subdomain`,
		reply: () => ({ result: { subdomain: "me" } }),
	},
	{
		method: "GET",
		path: `${A}/workers/scripts`,
		reply: () => ({ result: [{ id: "mdsync-relay", migration_tag: "v2" }] }),
	},
	{
		method: "GET",
		path: `${SCRIPT}/settings`,
		reply: () => ({
			result: {
				bindings: [
					{
						type: "kv_namespace",
						name: "SHARE_TOKENS",
						namespace_id: "kv-old",
					},
				],
			},
		}),
	},
	{
		method: "POST",
		path: `${SCRIPT}/assets-upload-session`,
		reply: () => ({ result: { jwt: "same", buckets: [] } }),
	},
];

describe("deployRelay onUploaded", () => {
	it("awaits the hook with the URL right after the worker upload, before the route is switched on", async () => {
		const cf = fakeCloudflare([...DEPLOYED, ...DEPLOY]);
		const seen: string[][] = [];
		let release: () => void = () => {};
		const onUploaded = vi.fn(
			(_url: string) =>
				new Promise<void>((resolve) => {
					seen.push(cf.paths());
					release = resolve;
				}),
		);

		const deploy = deployRelay({
			api: cf.api,
			accountId: "acc",
			bundle: BUNDLE,
			secret: "s",
			proposeSubdomain: () => "unused",
			onUploaded,
		});
		await vi.waitFor(() => expect(onUploaded).toHaveBeenCalled());
		const whileWaiting = cf.paths();
		release();
		await deploy;

		expect(onUploaded).toHaveBeenCalledWith(
			"https://mdsync-relay.me.workers.dev",
		);
		expect(seen[0]?.at(-1)).toBe(`PUT ${SCRIPT}`);
		expect(whileWaiting).toEqual(seen[0]);
		expect(cf.paths().at(-1)).toBe(`POST ${SCRIPT}/subdomain`);
	});

	it("has called the hook when a step after the upload fails", async () => {
		const cf = fakeCloudflare([
			...DEPLOYED,
			{
				method: "PUT",
				path: SCRIPT,
				reply: () => ({ result: { id: "mdsync-relay" } }),
			},
			{
				method: "POST",
				path: `${SCRIPT}/subdomain`,
				reply: () => failure(10000, 403),
			},
		]);
		const onUploaded = vi.fn(async (_url: string) => {});

		await expect(
			deployRelay({
				api: cf.api,
				accountId: "acc",
				bundle: BUNDLE,
				secret: "s",
				proposeSubdomain: () => "unused",
				onUploaded,
			}),
		).rejects.toThrow();

		expect(onUploaded).toHaveBeenCalledWith(
			"https://mdsync-relay.me.workers.dev",
		);
	});

	it("does not call the hook when the worker upload fails", async () => {
		const cf = fakeCloudflare([
			...DEPLOYED,
			{ method: "PUT", path: SCRIPT, reply: () => failure(10021, 400) },
		]);
		const onUploaded = vi.fn(async (_url: string) => {});

		await expect(
			deployRelay({
				api: cf.api,
				accountId: "acc",
				bundle: BUNDLE,
				secret: "s",
				proposeSubdomain: () => "unused",
				onUploaded,
			}),
		).rejects.toThrow();

		expect(onUploaded).not.toHaveBeenCalled();
	});
});

describe("workerNames", () => {
	it("lists the id of every script on the account", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({
					result: [{ id: "mdsync-relay", migration_tag: "v2" }, { id: "blog" }],
				}),
			},
		]);

		expect(await workerNames(cf.api, "acc")).toEqual(["mdsync-relay", "blog"]);
	});

	it("is empty for an account without scripts", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/scripts`,
				reply: () => ({ result: [] }),
			},
		]);

		expect(await workerNames(cf.api, "acc")).toEqual([]);
	});
});

describe("workersSubdomain", () => {
	it("returns the account's workers.dev name", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => ({ result: { subdomain: "me" } }),
			},
		]);

		expect(await workersSubdomain(cf.api, "acc")).toBe("me");
	});

	it("returns null before one is registered", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10007, 404),
			},
		]);

		expect(await workersSubdomain(cf.api, "acc")).toBeNull();
	});

	it("rethrows any other Cloudflare error", async () => {
		const cf = fakeCloudflare([
			{
				method: "GET",
				path: `${A}/workers/subdomain`,
				reply: () => failure(10000, 403),
			},
		]);

		await expect(workersSubdomain(cf.api, "acc")).rejects.toThrow();
	});
});

describe("workerUrl", () => {
	it("joins the script and account names under workers.dev", () => {
		expect(workerUrl("mdsync-relay", "me")).toBe(
			"https://mdsync-relay.me.workers.dev",
		);
	});
});
