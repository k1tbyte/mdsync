/** The socket to a relay, as far as this device can tell. */
export type LinkState = "connecting" | "connected" | "unauthorized" | "offline";

/** Why a space's relay channel is, or is not, carrying it. */
export type RelayStatus = "off" | "no-relay" | "paused" | LinkState;

export interface RelayFacts {
	realtime: boolean;
	paused: boolean;
	/** The socket meant to carry the space; null when none is. */
	link: LinkState | null;
	/** The relay cut this space's slot while its socket went on. */
	revoked: boolean;
}

export function relayStatus({
	realtime,
	paused,
	link,
	revoked,
}: RelayFacts): RelayStatus {
	if (paused) return "paused";
	if (!realtime) return "off";
	if (link === null) return "no-relay";
	return revoked ? "unauthorized" : link;
}

/** Whether a socket is meant to carry the space. */
export function isLinkState(status: RelayStatus): status is LinkState {
	return status !== "off" && status !== "no-relay" && status !== "paused";
}
