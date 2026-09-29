import type { LinkState, RelayStatus } from "@/hub/status";

export const RELAY_TEXT: Record<RelayStatus, string> = {
	off: "Real-time sync is off",
	"no-relay": "Set up the relay under Connection",
	paused: "Paused on this device: nothing syncs",
	connecting: "Connecting to the relay…",
	connected: "Relay connected",
	unauthorized:
		"The relay refused this device: check the relay secret or ask for a new invite",
	offline: "Relay unreachable: changes sync on the schedule",
};

export const UNREADABLE_TEXT = "Can't read others: different passphrase or key";

const SHORT_WORST_FIRST: readonly (readonly [LinkState, string])[] = [
	["unauthorized", "Relay refused"],
	["offline", "Relay offline"],
	["connecting", "Connecting…"],
];

/** The status bar's words for every space the relay carries: the worst problem, or Live. */
export function relaySummary(
	statuses: readonly LinkState[],
	unreadable: boolean,
): string {
	const worst = SHORT_WORST_FIRST.find(([status]) => statuses.includes(status));
	if (!worst) return unreadable ? "Live, can't read others" : "Live";
	const down = statuses.filter((status) => status !== "connected").length;
	return down === statuses.length ? worst[1] : `Live, ${down} offline`;
}
