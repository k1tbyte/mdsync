import type { LinkState } from "@/core/hub";

export type LiveState = "live" | "joining" | "offline" | "cold" | "warning";

export const LINK_LIVE_STATE: Record<LinkState, LiveState> = {
	connected: "live",
	connecting: "joining",
	offline: "offline",
	unauthorized: "offline",
};

/** The header pill's word; a status may name itself closer. */
export const STATE_TEXT: Record<LiveState, string> = {
	live: "Live",
	joining: "Joining",
	offline: "Offline",
	cold: "Not live",
	warning: "Not live",
};

export const STATE_ICONS: Record<LiveState, string> = {
	live: "radio",
	joining: "loader",
	offline: "wifi-off",
	cold: "circle-dashed",
	warning: "triangle-alert",
};
