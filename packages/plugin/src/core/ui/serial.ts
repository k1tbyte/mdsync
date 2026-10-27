/** Drops calls made while the last one is still running. */
export function serial<Args extends unknown[]>(
	action: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
	let pending = false;
	return async (...args) => {
		if (pending) return;
		pending = true;
		try {
			await action(...args);
		} finally {
			pending = false;
		}
	};
}
