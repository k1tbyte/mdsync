import type { PluginHost } from "@/app/host";
import { cloudflareApi, obsidianHttp, verifyToken } from "@/core/cloudflare";
import { STORAGE_CHANGED_REASON } from "@/core/constants";
import { sha256Hex } from "@/core/crypto";
import { activeStorage, type MdsyncSettings } from "@/core/settings";
import { REMOTE_MANIFEST_KEY } from "@/features/sync/constants";
import { defaultS3Config } from "../backends/s3";
import { isRefusedCredentials } from "../backends/util";
import { EStorageBackend, type S3StorageConfig } from "../config";
import { createStorageAdapter } from "../registry";
import { cloudflareOf } from "./cloudflare-login";
import { ensureBucket, r2AccountOf, r2Keys, r2Storage } from "./r2";

const BUCKET = "mdsync-vaults";
/** What R2 shows as the Secret Access Key: the hex SHA-256 of the token's value. */
const R2_SECRET = /^[0-9a-f]{64}$/i;

/** Makes the bucket (or finds it) and points the vault's S3 storage at it, under this vault's prefix. */
export async function useR2(plugin: PluginHost): Promise<void> {
	const login = cloudflareOf(plugin.settings);
	if (!login) throw new Error("Connect your Cloudflare account first.");
	const { api, accountId } = login;
	await ensureBucket(api, accountId, BUCKET);
	const tokenId = await verifyToken(api, accountId);
	const r2 = await r2Storage(accountId, BUCKET, tokenId, api.token);
	const current = plugin.settings.storageConfigs[EStorageBackend.S3];
	// Same bucket, same vault: a renamed vault, or one named otherwise on another device, keeps its folder.
	const kept =
		current?.kind === EStorageBackend.S3 &&
		current.endpoint === r2.endpoint &&
		current.bucket === BUCKET
			? current.prefix
			: null;
	plugin.settings.storageConfigs[EStorageBackend.S3] = {
		...defaultS3Config(),
		...r2,
		prefix: kept ?? (await vaultPrefix(plugin.app.vault.getName())),
	};
	plugin.settings.activeStorageKind = EStorageBackend.S3;
	await plugin.saveSettings();
	plugin.scheduleScopeRefresh(STORAGE_CHANGED_REASON);
}

/** The vault's R2 storage, or null when it is kept anywhere else. */
export function r2StorageOf(settings: MdsyncSettings): S3StorageConfig | null {
	const storage = activeStorage(settings);
	return storage.kind === EStorageBackend.S3 && r2AccountOf(storage.endpoint)
		? storage
		: null;
}

/**
 * New keys for the same bucket and prefix once their token was rolled or replaced. `value` is the token's
 * value or the Secret Access Key shown beside it; the keys must open the storage before anything is saved.
 */
export async function rekeyR2(
	plugin: PluginHost,
	value: string,
): Promise<void> {
	const { settings } = plugin;
	const s3 = r2StorageOf(settings);
	const accountId = s3 && r2AccountOf(s3.endpoint);
	if (!s3 || !accountId) throw new Error("This vault is not kept in R2.");
	const before = JSON.stringify(s3);
	const isSecret = R2_SECRET.test(value);
	const keys = isSecret
		? { accessKeyId: s3.accessKeyId, secretAccessKey: value.toLowerCase() }
		: await r2Keys(
				await verifyToken(cloudflareApi(obsidianHttp, value), accountId),
				value,
			);
	const next = { ...s3, ...keys };
	await createStorageAdapter(next)
		.exists(REMOTE_MANIFEST_KEY)
		.catch((err: unknown) => {
			throw isRefusedCredentials(err)
				? new Error(
						"R2 refuses these keys too. Paste the value of the token the storage keys came from.",
					)
				: err;
		});
	// The saved login was this token's old value: relay updates need the new one.
	const saved = settings.cloudflareToken;
	const login =
		!isSecret &&
		!!saved &&
		(await sha256Hex(new TextEncoder().encode(saved))) === s3.secretAccessKey;
	// Settings edited meanwhile win over this repair.
	if (JSON.stringify(activeStorage(settings)) !== before) {
		throw new Error("The storage settings changed meanwhile.");
	}
	if (login) settings.cloudflareToken = value;
	settings.storageConfigs[EStorageBackend.S3] = next;
	await plugin.saveSettings();
	plugin.scheduleScopeRefresh(STORAGE_CHANGED_REASON);
}

/** Two vaults of one account must not share a remote: names the slug folds together keep their own hash. */
export async function vaultPrefix(name: string): Promise<string> {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const hash = await sha256Hex(new TextEncoder().encode(name));
	return `${slug || "vault"}-${hash.slice(0, 8)}`;
}
