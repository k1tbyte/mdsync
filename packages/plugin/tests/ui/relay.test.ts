import { describe, expect, it } from "vitest";

import { relayFixOf, relaySummary } from "@/ui/common/relay";

describe("relay summary", () => {
	it("says the relay is connected while every space is, and what cannot be read", () => {
		expect(relaySummary(["connected", "connected"], false)).toBe(
			"Relay connected",
		);
		expect(relaySummary(["connected"], true)).toBe(
			"Relay connected, can't read others",
		);
	});

	it("counts the spaces that are up while others are down", () => {
		expect(relaySummary(["connected", "offline", "unauthorized"], false)).toBe(
			"Relay 1/3",
		);
	});

	it("names the worst problem once none is up", () => {
		expect(relaySummary(["offline", "connecting"], false)).toBe(
			"Relay offline",
		);
		expect(relaySummary(["offline", "unauthorized"], false)).toBe(
			"Relay refused",
		);
		expect(relaySummary(["connecting"], false)).toBe("Relay connecting…");
	});
});

describe("fixing the relay link", () => {
	it("reconnects an unreachable relay", () => {
		expect(relayFixOf("offline")).toBe("reconnect");
	});

	it("sends a refused device to the settings: a new socket cannot help", () => {
		expect(relayFixOf("unauthorized")).toBe("settings");
	});

	it("offers nothing while connecting, connected or not carried", () => {
		for (const status of [
			"connecting",
			"connected",
			"off",
			"no-relay",
			"paused",
		] as const) {
			expect(relayFixOf(status)).toBeNull();
		}
	});
});
