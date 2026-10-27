/** The one place an unknown throwable becomes text, so a caught error reads the same in notices, logs and status. */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	// Worker responses and structured-cloned errors carry a message without being Error instances.
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message) return message;
	}
	return String(err);
}

/** An Error as caught, anything else wrapped. */
export function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(errorMessage(err));
}
