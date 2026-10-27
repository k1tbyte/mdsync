/** Owned by core because `offline.ts` classifies them: a rename in a feature must not silently change what counts as offline. */

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
