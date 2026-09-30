import type { App } from "obsidian";

import { PLUGIN_ID } from "@/constants";
import { isConnected, type LinkState, type RelayStatus } from "@/hub/status";

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

export const UNREADABLE_TEXT =
	"Can't read everyone here: a different passphrase or access";

const SHORT_WORST_FIRST: readonly (readonly [LinkState, string])[] = [
	["unauthorized", "Relay refused"],
	["offline", "Relay offline"],
	["connecting", "Relay connecting…"],
];

export function relaySummary(
	statuses: readonly LinkState[],
	unreadable: boolean,
): string {
	const worst = SHORT_WORST_FIRST.find(([status]) => statuses.includes(status));
	if (!worst) {
		return unreadable
			? "Relay connected, can't read others"
			: RELAY_TEXT.connected;
	}
	const up = statuses.filter(isConnected).length;
	return up === 0 ? worst[1] : `Relay ${up}/${statuses.length}`;
}

export type RelayFix = "reconnect" | "settings";

/** A new socket helps an unreachable relay, not one that refused this device. */
export function relayFixOf(status: RelayStatus): RelayFix | null {
	if (status === "offline") return "reconnect";
	return status === "unauthorized" ? "settings" : null;
}

interface SettingsDialog {
	open(): void;
	openTabById(id: string): void;
}

export function openRelaySettings(app: App): void {
	const { setting } = app as App & { setting?: SettingsDialog };
	setting?.open();
	setting?.openTabById(PLUGIN_ID);
}
