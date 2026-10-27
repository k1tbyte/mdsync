/** The user stopped an operation: a normal outcome, so callers must not leave an error on the status. */
export class SyncCancelledError extends Error {
	constructor(message = "Cancelled.") {
		super(message);
		this.name = "SyncCancelledError";
	}
}

export function isCancellation(err: unknown): boolean {
	return err instanceof SyncCancelledError;
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new SyncCancelledError();
}
