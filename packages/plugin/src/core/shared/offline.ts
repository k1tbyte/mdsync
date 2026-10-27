import { errorMessage } from "./errors";
import { StorageHttpError, StorageTimeoutError } from "./transport-errors";

export const OFFLINE_MESSAGE = "No connection to the storage.";

/** Platform transport failures, as phrases: a bare word would also match a file called "network.md" in a domain error. */
const NETWORK_FAILURE =
	/network\s*(?:connection|request|error)\b|network is unreachable|failed to fetch|load failed|stream closed|socket hang up|unknown\s*host|unable to resolve host|internet connection|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETRESET|ERR_(?:NETWORK|CONNECTION|INTERNET|NAME_NOT_RESOLVED)/i;

/** A request that got no answer. */
export function isNetworkError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if (err instanceof StorageHttpError) return false;
	if (err instanceof StorageTimeoutError) return true;
	const { name, message } = err as { name?: string; message?: string };
	if (name === "TimeoutError") return true;
	return typeof message === "string" && NETWORK_FAILURE.test(message);
}

/** Any failure counts while the browser says it is offline: platforms word it too differently to match. */
export function isOffline(err?: unknown): boolean {
	return !navigator.onLine || isNetworkError(err);
}

/** What a person reads of a failed call: the offline line, else the error's own message. */
export function userMessage(err: unknown): string {
	return isOffline(err) ? OFFLINE_MESSAGE : errorMessage(err);
}
