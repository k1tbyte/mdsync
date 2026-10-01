/** An aborted signal stops new work; running work finishes, so nothing is left half-written. */
export async function runWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	// NaN would run the worker loop zero times and resolve as if every item were handled.
	const limit = Number.isFinite(concurrency) ? Math.max(1, concurrency) : 1;
	let cursor = 0;
	// One failure aborts the run, so the others stop pulling work instead of uploading behind the shown error.
	let failed = false;
	const runners: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		runners.push(
			(async () => {
				while (!failed && !signal?.aborted) {
					const index = cursor++;
					if (index >= items.length) return;
					try {
						await worker(items[index] as T, index);
					} catch (err) {
						failed = true;
						throw err;
					}
				}
			})(),
		);
	}
	await Promise.all(runners);
}
