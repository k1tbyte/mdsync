export interface Pull {
	ms: number;
	/** Of one core, for the whole bench process: client, proxies and S3 share it. */
	cpuPct: number;
	signMs: number[];
	objectMs: number[];
	/** One `adapter.get` from call to result, sign included. */
	fileMs: number[];
}

export const seconds = (ms: number): string => (ms / 1000).toFixed(2);

export const perSecond = (count: number, ms: number): string =>
	(count / (ms / 1000)).toFixed(0);

export function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.floor(sorted.length * fraction),
	);
	return sorted[index] ?? 0;
}

export const mean = (values: number[]): number =>
	values.reduce((sum, value) => sum + value, 0) / values.length;

/** "p50/mean/p95" in milliseconds. */
export function latency(values: number[]): string {
	return [percentile(values, 0.5), mean(values), percentile(values, 0.95)]
		.map((value) => value.toFixed(1))
		.join("/");
}

export function median(runs: Pull[]): Pull {
	const sorted = [...runs].sort((a, b) => a.ms - b.ms);
	return sorted[Math.floor(sorted.length / 2)] as Pull;
}
