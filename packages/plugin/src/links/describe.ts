import type { LinkStatus } from "@mdsync/protocol";
import { LINK_MAX_TTL_S } from "@mdsync/protocol";

import type { LinkRecord } from "./record";

const MS_PER_S = 1000;
const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;

export const EXPIRY_CHOICES = [
	{ key: "five-minutes", label: "5 minutes", seconds: 5 * MINUTE_S },
	{ key: "fifteen-minutes", label: "15 minutes", seconds: 15 * MINUTE_S },
	{ key: "hour", label: "1 hour", seconds: HOUR_S },
	{ key: "day", label: "1 day", seconds: DAY_S },
	{ key: "week", label: "7 days", seconds: 7 * DAY_S },
	{ key: "month", label: "30 days", seconds: 30 * DAY_S },
	{ key: "never", label: "Never", seconds: null },
	{ key: "date", label: "Pick a date…", seconds: "date" },
] as const;

export const VIEW_CHOICES = [
	{ key: "1", label: "1 view", views: 1 },
	{ key: "5", label: "5 views", views: 5 },
	{ key: "25", label: "25 views", views: 25 },
	{ key: "any", label: "Unlimited", views: null },
] as const;

export const DEFAULT_EXPIRY = "week";
export const DEFAULT_VIEWS = "any";

export function resolveExpiry(
	key: string,
	pickedDate: string,
	nowMs: number,
): { expires: number | null } | string {
	const choice = EXPIRY_CHOICES.find((choice) => choice.key === key);
	if (!choice) return "Choose an expiry.";
	if (choice.seconds !== "date") {
		return {
			expires:
				choice.seconds === null
					? null
					: Math.floor(nowMs / MS_PER_S) + choice.seconds,
		};
	}
	const pickedMs = new Date(pickedDate).getTime();
	if (!Number.isFinite(pickedMs)) return "Pick a date and time.";
	const aheadMs = pickedMs - nowMs;
	if (aheadMs < MINUTE_S * MS_PER_S) {
		return "Pick a date at least 1 minute ahead.";
	}
	if (aheadMs > LINK_MAX_TTL_S * MS_PER_S) {
		return `Pick a date no more than ${LINK_MAX_TTL_S / DAY_S} days ahead.`;
	}
	return { expires: Math.floor(pickedMs / MS_PER_S) };
}

export function expiryLine(expires: number | null): string {
	const text = expiryText(expires);
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Where a link stands, for its owner; `null` status means the relay no longer has it. */
export function linkStatusText(
	record: LinkRecord,
	status: LinkStatus | null,
): string {
	if (!status) return "Ended: it expired, was used up or was stopped.";
	const views =
		status.maxViews === null
			? `${status.views} ${status.views === 1 ? "view" : "views"}`
			: `${Math.max(status.maxViews - status.views, 0)} of ${status.maxViews} views left`;
	const parts = [views, expiryText(status.expires)];
	if (record.salt) parts.push("passphrase");
	return parts.join(" · ");
}

function expiryText(expires: number | null): string {
	if (expires === null) return "never expires";
	const when = new Date(expires * MS_PER_S).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
	return `expires ${when}`;
}

/** What the preview tells the owner was left out; empty when nothing was. */
export function leftOutText(left: {
	embeds: number;
	images: number;
	diagrams: number;
}): string {
	const parts: string[] = [];
	if (left.embeds) {
		parts.push(
			`${left.embeds} embedded ${left.embeds === 1 ? "file" : "files"}`,
		);
	}
	if (left.images) {
		parts.push(`${left.images} ${left.images === 1 ? "image" : "images"}`);
	}
	if (left.diagrams) {
		parts.push(
			`${left.diagrams} ${left.diagrams === 1 ? "diagram" : "diagrams"} (shown as text)`,
		);
	}
	return parts.join(", ");
}
