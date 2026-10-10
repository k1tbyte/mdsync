import { sha256Hex } from "@/crypto";
import type { S3StorageConfig } from "@/storage/config";

import { type CloudflareApi, hasCode } from "./api";

const BUCKET_OWNED = 10004;
const R2_NOT_ENABLED = 10042;

/** R2 needs a one-time opt-in with a payment method in the dashboard, even on the free tier. */
export class R2NotEnabledError extends Error {
	override name = "R2NotEnabledError";
	constructor(readonly accountId: string) {
		super("R2 is not enabled on this Cloudflare account yet.");
	}
}

export function r2DashboardUrl(accountId: string): string {
	return `https://dash.cloudflare.com/${accountId}/r2/overview`;
}

export async function ensureBucket(
	api: CloudflareApi,
	accountId: string,
	name: string,
): Promise<void> {
	try {
		await api.call("POST", `/accounts/${accountId}/r2/buckets`, {
			json: { name },
		});
	} catch (err) {
		if (hasCode(err, BUCKET_OWNED)) return;
		if (hasCode(err, R2_NOT_ENABLED)) throw new R2NotEnabledError(accountId);
		throw err;
	}
}

export type R2Storage = Pick<
	S3StorageConfig,
	"endpoint" | "region" | "bucket" | "accessKeyId" | "secretAccessKey"
>;

/** Cloudflare's S3 derivation: the token's id and the SHA-256 of its value; nothing is minted. */
export async function r2Storage(
	accountId: string,
	bucket: string,
	tokenId: string,
	token: string,
): Promise<R2Storage> {
	return {
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		region: "auto",
		bucket,
		accessKeyId: tokenId,
		secretAccessKey: await sha256Hex(new TextEncoder().encode(token)),
	};
}
