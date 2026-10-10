import { type CloudflareApi, hasCode } from "./api";

const TOKEN_NAME = "MDSync";
const INVALID_TOKEN = 1000;

/** Everything the relay deploy and the R2 storage setup call. */
const PERMISSIONS = [
	{ key: "workers_scripts", type: "edit" },
	{ key: "workers_kv_storage", type: "edit" },
	{ key: "workers_r2", type: "edit" },
	{ key: "account_settings", type: "read" },
] as const;

/**
 * Opens the dashboard's account token form with these permissions picked; the user picks the account
 * and confirms. An account token reaches that one account, unlike a user token's `accountId=*`.
 */
export function tokenTemplateUrl(): string {
	const params = new URLSearchParams({
		to: "/:account/api-tokens",
		permissionGroupKeys: JSON.stringify(PERMISSIONS),
		name: TOKEN_NAME,
	});
	return `https://dash.cloudflare.com/?${params}`;
}

export interface CloudflareAccount {
	id: string;
	name: string;
}

/**
 * The token's id doubles as the R2 access key id. An account token (`cfat_`) verifies only under its
 * account and a user token only under `/user`; each calls the other invalid.
 */
export async function verifyToken(
	api: CloudflareApi,
	accountId: string,
): Promise<string> {
	type Verified = { id: string; status: string };
	let verified: Verified;
	try {
		verified = await api.call<Verified>(
			"GET",
			`/accounts/${accountId}/tokens/verify`,
		);
	} catch (err) {
		if (!hasCode(err, INVALID_TOKEN)) throw err;
		verified = await api.call<Verified>("GET", "/user/tokens/verify");
	}
	if (verified.status !== "active") {
		throw new Error(`The Cloudflare token is ${verified.status}.`);
	}
	return verified.id;
}

export function listAccounts(api: CloudflareApi): Promise<CloudflareAccount[]> {
	// The API's largest page; an account token reaches one account anyway.
	return api.call<CloudflareAccount[]>("GET", "/accounts?per_page=50");
}
