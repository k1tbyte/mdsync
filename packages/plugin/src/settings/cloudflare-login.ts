import {
	type CloudflareAccount,
	type CloudflareApi,
	cloudflareApi,
	listAccounts,
	verifyToken,
} from "@/cloudflare";
import { obsidianHttp } from "@/cloudflare/obsidian-http";
import type { PluginHost } from "@/plugin/host";
import type { MdsyncSettings } from "@/settings/model";

export interface CloudflareLogin {
	api: CloudflareApi;
	accountId: string;
}

/** The connected account, or null before a token is saved here. */
export function cloudflareOf(settings: MdsyncSettings): CloudflareLogin | null {
	const { cloudflareToken: token, cloudflareAccountId: accountId } = settings;
	return token && accountId
		? { api: cloudflareApi(obsidianHttp, token), accountId }
		: null;
}

export async function accountsOf(token: string): Promise<CloudflareAccount[]> {
	const accounts = await listAccounts(cloudflareApi(obsidianHttp, token));
	if (accounts.length === 0) {
		throw new Error("This token reaches no Cloudflare account.");
	}
	return accounts;
}

/** Verified before it is kept: a revoked or expired token would fail every later step. */
export async function connectCloudflare(
	plugin: PluginHost,
	token: string,
	accountId: string,
): Promise<void> {
	await verifyToken(cloudflareApi(obsidianHttp, token), accountId);
	Object.assign(plugin.settings, {
		cloudflareToken: token,
		cloudflareAccountId: accountId,
	});
	await plugin.saveSettings();
}

export async function forgetCloudflare(plugin: PluginHost): Promise<void> {
	Object.assign(plugin.settings, {
		cloudflareToken: "",
		cloudflareAccountId: "",
	});
	await plugin.saveSettings();
}
