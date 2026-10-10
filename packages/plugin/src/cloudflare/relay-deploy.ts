import { type CloudflareApi, hasCode } from "./api";
import { uploadAssets } from "./assets";
import type { RelayBundle } from "./bundle";
import { type MigrationUpload, pendingMigrations } from "./migrations";
import { encodeForm } from "./multipart";

export const ERelayDeployStep = {
	Subdomain: "subdomain",
	Storage: "storage",
	Files: "files",
	Worker: "worker",
	Route: "route",
} as const;
export type ERelayDeployStep =
	(typeof ERelayDeployStep)[keyof typeof ERelayDeployStep];

export interface RelayDeployOptions {
	api: CloudflareApi;
	accountId: string;
	bundle: RelayBundle;
	secret: string;
	/** A workers.dev name to register when the account has none yet; called again if one is taken. */
	proposeSubdomain: () => string;
	onStep?: (step: ERelayDeployStep) => void;
	/** Awaited once the worker holds the secret, before its URL is switched on. */
	onUploaded?: (url: string) => Promise<void>;
}

const SECRET_BINDING = "RELAY_SECRET";
const VERSION_BINDING = "RELAY_VERSION";
const NO_SUBDOMAIN = 10007;
const SUBDOMAIN_TAKEN = 10031;
const SUBDOMAIN_ATTEMPTS = 3;

interface DeployedScript {
	migrationTag?: string;
	kv: Map<string, string>;
}

/** Creates or updates the relay in place; returns its URL, which may need minutes to answer the first time. */
export async function deployRelay(o: RelayDeployOptions): Promise<string> {
	const { api, bundle } = o;
	const account = `/accounts/${o.accountId}`;
	const script = `${account}/workers/scripts/${bundle.name}`;

	o.onStep?.(ERelayDeployStep.Subdomain);
	const subdomain = await ensureSubdomain(api, o.accountId, o.proposeSubdomain);

	o.onStep?.(ERelayDeployStep.Storage);
	const deployed = await deployedScript(api, account, bundle.name);
	const kv = new Map<string, string>();
	for (const binding of bundle.kvBindings) {
		// An existing relay keeps its namespace: a new one would orphan every share token.
		kv.set(
			binding,
			deployed?.kv.get(binding) ??
				(await ensureNamespace(
					api,
					account,
					namespaceTitle(bundle.name, binding),
				)),
		);
	}
	const migrations = pendingMigrations(
		bundle.migrations,
		deployed?.migrationTag,
	);

	o.onStep?.(ERelayDeployStep.Files);
	const assetsJwt = await uploadAssets(
		api,
		account,
		bundle.name,
		bundle.assets.files,
	);

	o.onStep?.(ERelayDeployStep.Worker);
	await api.call("PUT", script, {
		form: uploadForm(bundle, o.secret, kv, migrations, assetsJwt),
	});
	const url = workerUrl(bundle.name, subdomain);
	await o.onUploaded?.(url);

	o.onStep?.(ERelayDeployStep.Route);
	await api.call("POST", `${script}/subdomain`, {
		json: { enabled: true, previews_enabled: false },
	});
	return url;
}

export function workerUrl(name: string, subdomain: string): string {
	return `https://${name}.${subdomain}.workers.dev`;
}

/** The account's workers.dev name, or null before one is registered. */
export async function workersSubdomain(
	api: CloudflareApi,
	accountId: string,
): Promise<string | null> {
	try {
		const current = await api.call<{ subdomain?: string } | null>(
			"GET",
			`/accounts/${accountId}/workers/subdomain`,
		);
		return current?.subdomain || null;
	} catch (err) {
		if (hasCode(err, NO_SUBDOMAIN)) return null;
		throw err;
	}
}

export async function workerNames(
	api: CloudflareApi,
	accountId: string,
): Promise<string[]> {
	return (await listScripts(api, `/accounts/${accountId}`)).map((s) => s.id);
}

function listScripts(
	api: CloudflareApi,
	account: string,
): Promise<Array<{ id: string; migration_tag?: string }>> {
	return api.call("GET", `${account}/workers/scripts`);
}

async function ensureSubdomain(
	api: CloudflareApi,
	accountId: string,
	propose: () => string,
): Promise<string> {
	const current = await workersSubdomain(api, accountId);
	if (current) return current;
	for (let attempt = 1; ; attempt++) {
		try {
			const created = await api.call<{ subdomain: string }>(
				"PUT",
				`/accounts/${accountId}/workers/subdomain`,
				{ json: { subdomain: propose() } },
			);
			return created.subdomain;
		} catch (err) {
			if (!hasCode(err, SUBDOMAIN_TAKEN) || attempt >= SUBDOMAIN_ATTEMPTS) {
				throw err;
			}
		}
	}
}

async function deployedScript(
	api: CloudflareApi,
	account: string,
	name: string,
): Promise<DeployedScript | null> {
	const found = (await listScripts(api, account)).find((s) => s.id === name);
	if (!found) return null;
	const settings = await api.call<{
		bindings?: Array<{ type: string; name: string; namespace_id?: string }>;
	}>("GET", `${account}/workers/scripts/${name}/settings`);
	const kv = new Map<string, string>();
	for (const b of settings.bindings ?? []) {
		if (b.type === "kv_namespace" && b.namespace_id)
			kv.set(b.name, b.namespace_id);
	}
	return { migrationTag: found.migration_tag, kv };
}

/** Wrangler's title for a namespace it provisions, so a relay first deployed by the GitHub action is found. */
function namespaceTitle(script: string, binding: string): string {
	return `${script}-${binding.toLowerCase().replace(/_/g, "-")}`;
}

/** Found by title first, so a relay deleted and deployed again finds its tokens. */
async function ensureNamespace(
	api: CloudflareApi,
	account: string,
	title: string,
): Promise<string> {
	const namespaces = await api.call<Array<{ id: string; title: string }>>(
		"GET",
		`${account}/storage/kv/namespaces?per_page=1000`,
	);
	const existing = namespaces.find((n) => n.title === title);
	if (existing) return existing.id;
	const created = await api.call<{ id: string }>(
		"POST",
		`${account}/storage/kv/namespaces`,
		{ json: { title } },
	);
	return created.id;
}

function uploadForm(
	bundle: RelayBundle,
	secret: string,
	kv: ReadonlyMap<string, string>,
	migrations: MigrationUpload | undefined,
	assetsJwt: string,
) {
	const metadata = {
		main_module: bundle.mainModule,
		compatibility_date: bundle.compatibilityDate,
		compatibility_flags: bundle.compatibilityFlags,
		bindings: [
			...[...kv].map(([name, id]) => ({
				type: "kv_namespace",
				name,
				namespace_id: id,
			})),
			...bundle.durableObjects.map((d) => ({
				type: "durable_object_namespace",
				name: d.name,
				class_name: d.className,
			})),
			{ type: "assets", name: bundle.assets.binding },
			{ type: "plain_text", name: VERSION_BINDING, text: bundle.version },
			{ type: "secret_text", name: SECRET_BINDING, text: secret },
		],
		// Keeps secrets set outside MDSync (the Google Drive client); the relay secret above still wins.
		keep_bindings: ["secret_text"],
		...(migrations ? { migrations } : {}),
		assets: {
			jwt: assetsJwt,
			config: { run_worker_first: bundle.assets.runWorkerFirst },
		},
	};
	return encodeForm([
		{
			name: "metadata",
			type: "application/json",
			data: JSON.stringify(metadata),
		},
		{
			name: bundle.mainModule,
			filename: bundle.mainModule,
			type: "application/javascript+module",
			data: bundle.worker,
		},
	]);
}
