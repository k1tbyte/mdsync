import { describe, expect, it } from "vitest";

import {
	isLinkState,
	type LinkState,
	type RelayFacts,
	relayStatus,
} from "@/hub/status";

const facts = (over: Partial<RelayFacts> = {}): RelayFacts => ({
	realtime: true,
	paused: false,
	link: "connected",
	revoked: false,
	full: false,
	...over,
});

describe("relayStatus", () => {
	it("passes the socket's state through for a carried space", () => {
		const states: LinkState[] = [
			"connecting",
			"connected",
			"unauthorized",
			"offline",
		];
		for (const link of states) {
			expect(relayStatus(facts({ link }))).toBe(link);
		}
	});

	it("reads a slot the relay cut as unauthorized while its socket goes on", () => {
		expect(relayStatus(facts({ revoked: true }))).toBe("unauthorized");
	});

	it("says off, no relay or paused before anything about a socket", () => {
		expect(relayStatus(facts({ realtime: false }))).toBe("off");
		expect(relayStatus(facts({ link: null }))).toBe("no-relay");
		expect(relayStatus(facts({ paused: true }))).toBe("paused");
	});

	it("tells a space the relay had no slot left for from one with no relay", () => {
		expect(relayStatus(facts({ link: null, full: true }))).toBe("full");
		expect(isLinkState("full")).toBe(false);
	});

	it("keeps a paused space paused with real-time off or no socket", () => {
		expect(relayStatus(facts({ paused: true, realtime: false }))).toBe(
			"paused",
		);
		expect(relayStatus(facts({ paused: true, link: null }))).toBe("paused");
		expect(relayStatus(facts({ realtime: false, link: null }))).toBe("off");
	});
});

describe("isLinkState", () => {
	it("is true only where a socket is meant to carry the space", () => {
		expect(isLinkState("offline")).toBe(true);
		expect(isLinkState("connected")).toBe(true);
		expect(isLinkState("off")).toBe(false);
		expect(isLinkState("no-relay")).toBe(false);
		expect(isLinkState("paused")).toBe(false);
	});
});
