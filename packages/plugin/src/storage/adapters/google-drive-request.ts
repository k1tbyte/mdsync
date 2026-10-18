import { type RequestUrlParam, requestUrl } from "obsidian";
import { StorageRequestError } from "@/storage/types";
import {
	isRetryableStatus,
	STORAGE_TIMEOUT_MS,
	StorageHttpError,
	withRetry,
	withTimeout,
} from "./util";

const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
/** Drive answers usage limits with 403: a busy or full account, not refused credentials. */
const USAGE_LIMIT =
	/"reason"\s*:\s*"(rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|storageQuotaExceeded)"/;

export type DriveResponse = Awaited<ReturnType<typeof requestUrl>>;

/**
 * Sends a request with a fresh Authorization header, replacing the token once on a 401; uploads use it too
 * since a long sync outlives a token.
 */
export type AuthorizedRequest = (
	params: Omit<RequestUrlParam, "throw">,
) => Promise<DriveResponse>;

export async function driveRequest(
	params: Parameters<typeof requestUrl>[0],
): Promise<DriveResponse> {
	return withRetry(async () => {
		const res = await withTimeout(requestUrl(params), STORAGE_TIMEOUT_MS);
		const limit =
			res.status === FORBIDDEN ? USAGE_LIMIT.exec(res.text)?.[1] : undefined;
		if (limit === "storageQuotaExceeded") {
			throw new StorageRequestError(
				"Google Drive storage quota exceeded (HTTP 403)",
				"Google Drive is full. Free up space in it, then sync again.",
			);
		}
		// Retried as the 429 it is, never read as refused credentials.
		if (isRetryableStatus(res.status) || limit) {
			throw new StorageHttpError(
				limit ? TOO_MANY_REQUESTS : res.status,
				`Google Drive request failed (HTTP ${res.status})`,
			);
		}
		return res;
	});
}
