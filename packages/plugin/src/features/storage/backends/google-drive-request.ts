import { type RequestUrlParam, requestUrl } from "obsidian";
import { StorageRequestError } from "../types";
import {
	isRetryableStatus,
	StorageHttpError,
	transferBytes,
	withDeadline,
	withRetry,
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
	expected?: number,
) => Promise<DriveResponse>;

/** `expected`: bytes a body-less request is expected to receive. */
export async function driveRequest(
	params: RequestUrlParam,
	expected?: number,
): Promise<DriveResponse> {
	return withRetry(async () => {
		const res = await withDeadline(
			requestUrl(params),
			transferBytes(params.body, expected),
		);
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
