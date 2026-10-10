import { ensureBucket, r2Storage, verifyToken } from "@/cloudflare";
import { STORAGE_CHANGED_REASON } from "@/constants";
import { sha256Hex } from "@/crypto";
import type { PluginHost } from "@/plugin/host";
import { cloudflareOf } from "@/settings/cloudflare-login";
import { defaultS3Config, EStorageBackend } from "@/storage";

const BUCKET = "mdsync-vaults";

/** Makes the bucket (or finds it) and points the vault's S3 storage at it, under this vault's prefix. */
export async function useR2(plugin: PluginHost): Promise<void> {
	const login = cloudflareOf(plugin.settings);
	if (!login) throw new Error("Connect your Cloudflare account first.");
	const { api, accountId } = login;
	await ensureBucket(api, accountId, BUCKET);
	const tokenId = await verifyToken(api, accountId);
	const r2 = await r2Storage(accountId, BUCKET, tokenId, api.token);
	plugin.settings.storageConfigs[EStorageBackend.S3] = {
		...defaultS3Config(),
		...r2,
		prefix: await vaultPrefix(plugin.app.vault.getName()),
	};
	plugin.settings.activeStorageKind = EStorageBackend.S3;
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
