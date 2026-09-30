import type { LinkState } from "@/hub/status";

export type LiveState = "live" | "joining" | "offline" | "cold" | "warning";

export const LINK_LIVE_STATE: Record<LinkState, LiveState> = {
	connected: "live",
	connecting: "joining",
	offline: "offline",
	unauthorized: "offline",
};

export const STATE_ICONS: Record<LiveState, string> = {
	live: "radio",
	joining: "loader",
	offline: "wifi-off",
	cold: "circle-dashed",
	warning: "triangle-alert",
};
