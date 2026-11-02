import {
	type CloudflareAccount,
	type CloudflareApi,
	cloudflareApi,
	hasCode,
	listAccounts,
	obsidianHttp,
	verifyToken,
} from "@/core/cloudflare";
import type { MdsyncSettings } from "@/core/settings";
import { errorMessage } from "@/core/shared";
import type { StorageHost } from "../host";

/** A per-Worker token or a role without the legacy Workers Scripts permission. */
const AUTH_ERROR = 10000;

export interface CloudflareLogin {
	api: CloudflareApi;
	accountId: string;
}

export function cloudflareErrorMessage(err: unknown): string {
	return hasCode(err, AUTH_ERROR)
		? "Cloudflare refused the token. Create it again with Open Cloudflare, keeping every permission it selects, and paste the new one."
		: errorMessage(err);
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
	plugin: StorageHost,
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

export async function forgetCloudflare(plugin: StorageHost): Promise<void> {
	Object.assign(plugin.settings, {
		cloudflareToken: "",
		cloudflareAccountId: "",
	});
	await plugin.saveSettings();
}
