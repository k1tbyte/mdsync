import { isNetworkError } from "@/shared";

const RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 2_000, 5_000];

const STORAGE_TIMEOUT_MS = 30_000;
/** The slowest link a transfer is still expected to finish on. */
const FLOOR_BYTES_PER_SECOND = 128 * 1024;
/** A timeout past this size is not retried in place: requestUrl cannot be cancelled, so the first request is still running. */
const RETRY_MAX_BYTES = 1024 * 1024;

export class StorageHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "StorageHttpError";
	}
}

export class StorageTimeoutError extends Error {
	constructor(
		ms: number,
		readonly bytes = 0,
	) {
		super(`Storage operation timed out after ${ms}ms`);
		this.name = "StorageTimeoutError";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	bytes = 0,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = window.setTimeout(
			() => reject(new StorageTimeoutError(ms, bytes)),
			ms,
		);
		promise.then(
			(value) => {
				window.clearTimeout(id);
				resolve(value);
			},
			(err: unknown) => {
				window.clearTimeout(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

/** What a request moves: its body, else the bytes its answer is expected to carry. */
export function transferBytes(
	body: string | { byteLength: number } | undefined,
	expected = 0,
): number {
	if (body === undefined) return expected;
	return typeof body === "string" ? body.length : body.byteLength;
}

/** The shared timeout: a fixed allowance plus the time `bytes` take at the floor rate. */
export function withDeadline<T>(
	promise: Promise<T>,
	bytes: number,
): Promise<T> {
	const transfer = Math.ceil((bytes / FLOOR_BYTES_PER_SECOND) * 1000);
	return withTimeout(promise, STORAGE_TIMEOUT_MS + transfer, bytes);
}

/** 5xx answers patience cannot change. */
const FINAL_5XX = new Set([501, 505, 507]);

/** Retryable statuses (e.g. 429, 5xx). 4xx errors are definitive answers, not retried. */
export function isRetryableStatus(status: number): boolean {
	if (FINAL_5XX.has(status)) return false;
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The storage turned this device's credentials away: rotated, revoked or mistyped. */
export function isRefusedCredentials(err: unknown): boolean {
	return (
		err instanceof StorageHttpError &&
		(err.status === 401 || err.status === 403)
	);
}

export function isRetryableError(err: unknown): boolean {
	if (err instanceof StorageTimeoutError) return err.bytes <= RETRY_MAX_BYTES;
	if (err instanceof StorageHttpError) return isRetryableStatus(err.status);
	if (!err || typeof err !== "object") return false;
	// A cancelled request is a decision, not a hiccup: retrying it ignores the caller that asked to stop.
	if ((err as { name?: string }).name === "AbortError") return false;
	return isNetworkError(err);
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	isRetryable: (err: unknown) => boolean = isRetryableError,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || attempt === RETRY_DELAYS_MS.length) break;
			await delay(RETRY_DELAYS_MS[attempt] as number);
		}
	}
	throw lastErr;
}

/** Treat 3xx as failure to prevent saving redirect pages as object bytes. */
export function assertOk(
	res: { status: number; text?: string },
	action: string,
	key: string,
): void {
	if (res.status >= 200 && res.status < 300) return;
	const detail = res.text ? `: ${res.text.slice(0, 200)}` : "";
	throw new StorageHttpError(
		res.status,
		`Failed to ${action} "${key}" (HTTP ${res.status})${detail}`,
	);
}

/** The `error` code of a relay's JSON refusal; null for anything else. */
export function errorCode(text: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		const code = (parsed as { error?: unknown } | null)?.error;
		return typeof code === "string" ? code : null;
	} catch {
		return null;
	}
}

/** Header lookup that does not assume the platform's casing. */
export function headerValue(
	headers: Record<string, string> | undefined,
	name: string,
): string | null {
	if (!headers) return null;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return null;
}

/** A listing's date (ISO 8601 or RFC 1123) as epoch ms; null when absent or unreadable. */
export function dateOf(text: string | null | undefined): number | null {
	const ms = text ? Date.parse(text.trim()) : Number.NaN;
	return Number.isNaN(ms) ? null : ms;
}
