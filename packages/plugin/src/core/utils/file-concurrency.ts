import { runWithConcurrency } from "./concurrency";

export const LARGE_FILE_BYTES = 8 * 1024 * 1024;

export function createLargeFileGate(): <T>(
	run: () => Promise<T>,
) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(run: () => Promise<T>): Promise<T> => {
		const next = tail.then(run);
		tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
}

export function runWithFileConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	sizeOf: (item: T) => number,
	worker: (item: T, index: number) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	const gate = createLargeFileGate();
	let failed = false;
	return runWithConcurrency(
		items,
		concurrency,
		(item, index) => {
			const run = async (): Promise<void> => {
				if (signal?.aborted || failed) return;
				try {
					await worker(item, index);
				} catch (err) {
					failed = true;
					throw err;
				}
			};
			return sizeOf(item) >= LARGE_FILE_BYTES ? gate(run) : run();
		},
		signal,
	);
}
