import { type FileView, MarkdownView, TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import type { RelayStatus } from "@/hub/status";
import type { ColdCause } from "@/live/sessions";
import type { PluginHost } from "@/plugin/host";
import { liveStatusOf } from "@/ui/live/live-status";
import {
	RELAY_TEXT,
	relaySummary,
	UNREADABLE_TEXT,
} from "@/ui/live/relay-text";

interface Facts {
	status: RelayStatus;
	unreadable: boolean;
	room: boolean;
	joining: boolean;
	unanswered: boolean;
	cold: ColdCause | null;
	liveEditing: boolean;
}

const FACTS: Facts = {
	status: "connected",
	unreadable: false,
	room: false,
	joining: false,
	unanswered: false,
	cold: null,
	liveEditing: true,
};

function statusOf(facts: Partial<Facts> = {}, file = note("a.md")) {
	const all = { ...FACTS, ...facts };
	const plugin = {
		app: { metadataCache: { getFileCache: () => null } },
		settings: { liveEditing: all.liveEditing },
		spaces: { partition: () => [] },
		realtime: {
			statusOf: () => all.status,
			people: { unreadable: () => all.unreadable },
			live: {
				roomOf: () => (all.room ? {} : null),
				joining: () => all.joining,
				unanswered: () => all.unanswered,
				coldCause: () => all.cold,
			},
		},
	} as unknown as PluginHost;
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		getViewType: () => "markdown",
		getMode: () => "source",
	}) as FileView;
	return liveStatusOf(plugin, view, file);
}

function note(path: string, size = 10): TFile {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		stat: { size },
	});
}

describe("live status of a note", () => {
	it("is absent where no relay is meant to carry the space", () => {
		expect(statusOf({ status: "off" })).toBeNull();
		expect(statusOf({ status: "no-relay" })).toBeNull();
	});

	it("says paused whatever the relay does", () => {
		expect(statusOf({ status: "paused" })).toEqual({
			state: "cold",
			label: RELAY_TEXT.paused,
		});
	});

	it("tells connecting, offline and refused apart", () => {
		const connecting = statusOf({ status: "connecting" });
		const offline = statusOf({ status: "offline" });
		const refused = statusOf({ status: "unauthorized" });

		expect(connecting).toEqual({
			state: "joining",
			label: RELAY_TEXT.connecting,
		});
		expect(offline).toEqual({ state: "offline", label: RELAY_TEXT.offline });
		expect(refused).toEqual({
			state: "offline",
			label: RELAY_TEXT.unauthorized,
		});
		expect(
			new Set([connecting?.label, offline?.label, refused?.label]).size,
		).toBe(3);
	});

	it("names a different passphrase before claiming to be live", () => {
		expect(statusOf({ unreadable: true, room: true })).toEqual({
			state: "offline",
			label: UNREADABLE_TEXT,
		});
	});

	it("is live once its room answered", () => {
		expect(statusOf({ room: true })?.state).toBe("live");
	});

	it("gives up on a room that never answers, with its own label", () => {
		const waiting = statusOf({ joining: true });
		const silent = statusOf({ joining: true, unanswered: true });

		expect(waiting?.state).toBe("joining");
		expect(silent?.state).toBe("offline");
		expect(silent?.label).toMatch(/not answering/);
	});

	it("keeps 'not a live note' apart from 'too large'", () => {
		const image = statusOf({}, note("image.png"))?.label;
		const huge = statusOf({}, note("huge.md", 300 * 1024))?.label;
		const fine = statusOf({}, note("fine.md"))?.label;

		expect(image).toMatch(/^Not a live note/);
		expect(huge).toMatch(/^Too large to edit live/);
		expect(fine).toMatch(/^Waiting for the key/);
	});
});

describe("relay summary", () => {
	it("says Live while every space is connected, and what cannot be read", () => {
		expect(relaySummary(["connected", "connected"], false)).toBe("Live");
		expect(relaySummary(["connected"], true)).toBe("Live, can't read others");
	});

	it("counts the spaces that are down while others are up", () => {
		expect(relaySummary(["connected", "offline", "unauthorized"], false)).toBe(
			"Live, 2 offline",
		);
	});

	it("names the worst problem once none is up", () => {
		expect(relaySummary(["offline", "connecting"], false)).toBe(
			"Relay offline",
		);
		expect(relaySummary(["offline", "unauthorized"], false)).toBe(
			"Relay refused",
		);
		expect(relaySummary(["connecting"], false)).toBe("Connecting…");
	});
});
