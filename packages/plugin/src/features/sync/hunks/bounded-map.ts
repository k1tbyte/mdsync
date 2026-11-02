/** Drops the oldest entries until the rest fits; the newest stays even alone over `max`, its reader still needs it. */
export function trimOldest<K, V>(
	entries: Map<K, V>,
	max: number,
	weight: (value: V) => number = () => 1,
	maxEntries = Number.POSITIVE_INFINITY,
): void {
	let total = 0;
	for (const value of entries.values()) total += weight(value);
	for (const [key, value] of entries) {
		if (entries.size === 1) break;
		if (total <= max && entries.size <= maxEntries) break;
		entries.delete(key);
		total -= weight(value);
	}
}
