import { device, record } from "@tests/helpers/space-records";
import { describe, expect, it } from "vitest";

import type { SpaceRecord } from "@/spaces/record";
import { shareSummary } from "@/ui/shares/share-summary";

const joined = (readOnly?: true): SpaceRecord => ({
	...record("b", "Friends"),
	access: {
		kind: "participant",
		relayUrl: "u",
		token: "t",
		participantId: "p",
		personName: "Me",
		...(readOnly ? { readOnly } : {}),
	},
});

describe("shareSummary", () => {
	it("says whose the share is and where", () => {
		const { records } = device([record("a", "Team"), joined()]);

		expect(shareSummary(records, record("a", "Team"))).toBe(
			'Yours, in "Team".',
		);
		expect(shareSummary(records, joined())).toBe(
			'Shared with you, in "Friends".',
		);
	});

	it("names read-only and paused", async () => {
		const { records } = device([joined(true)]);
		await records.setPause("b", "here", "laptop");

		expect(shareSummary(records, joined(true))).toBe(
			'Shared with you, read-only, in "Friends", paused on this device.',
		);
	});

	it("names a pause on all their devices, and shared folders off here", async () => {
		const { records, settings } = device([record("a", "Team")]);
		await records.setPause("a", "everywhere", "laptop");
		expect(shareSummary(records, record("a", "Team"))).toBe(
			'Yours, in "Team", paused on all your devices.',
		);

		settings.useSharedFolders = false;
		expect(shareSummary(records, record("a", "Team"))).toBe(
			'Yours, in "Team", shared folders are off on this device.',
		);
	});

	it("says when another share holds the folder", () => {
		const { records } = device([record("a", "Team"), record("b", "Team")]);

		expect(shareSummary(records, record("b", "Team"))).toBe(
			'Not syncing: another shared folder already holds "Team".',
		);
	});
});
