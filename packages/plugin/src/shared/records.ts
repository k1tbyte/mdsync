/**
 * Own-property lookup: a file named `constructor` or `toString` would otherwise return an Object.prototype
 * member, which is truthy.
 */
export function entryAt<T>(
	map: Record<string, T>,
	path: string,
): T | undefined {
	return Object.hasOwn(map, path) ? map[path] : undefined;
}

/**
 * Stable key order, so unchanged content never rewrites megabytes, and sorted paths compress 8.5% smaller.
 * Array-index paths ("42") still hoist, identically everywhere: equal records need only serialise identically.
 */
export function sortedByPath<T>(record: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const key of Object.keys(record).sort()) {
		out[key] = record[key] as T;
	}
	return out;
}
