const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "Expires in 5 min", "in 3 hours", then the date once it is a day or more away. */
export function expiryText(expires: number, nowMs: number): string {
	const leftMs = expires * 1000 - nowMs;
	if (leftMs <= 0) {
		return "Expired. This tab keeps the note until you close it.";
	}
	if (leftMs < HOUR_MS) {
		return `Expires in ${Math.ceil(leftMs / MINUTE_MS)} min.`;
	}
	if (leftMs < DAY_MS) {
		const hours = Math.round(leftMs / HOUR_MS);
		return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
	}
	const date = new Date(expires * 1000);
	const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
	const when = date.toLocaleString(undefined, {
		year: sameYear ? undefined : "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return `Expires ${when}.`;
}
