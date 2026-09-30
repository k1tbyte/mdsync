import { type FileView, MarkdownView, TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import type { RelayStatus } from "@/hub/status";
import type { ColdCause } from "@/live/workspace/sessions";
import type { PluginHost } from "@/plugin/host";
import { spaceOf } from "@/sync/space";
import { RELAY_TEXT, UNREADABLE_TEXT } from "@/ui/common/relay";
import { liveStatusOf } from "@/ui/live/header/live-status";

interface Facts {
	status: RelayStatus;
	unreadable: boolean;
	room: boolean;
	joining: boolean;
	unanswered: boolean;
	cold: ColdCause | null;
	liveEditing: boolean;
	spaces: { readOnly: true }[];
}

const FACTS: Facts = {
	status: "connected",
	unreadable: false,
	room: false,
	joining: false,
	unanswered: false,
	cold: null,
	liveEditing: true,
	spaces: [],
};

function statusOf(facts: Partial<Facts> = {}, file = note("a.md")) {
	const all = { ...FACTS, ...facts };
	const partition = all.spaces.map((space) => ({
		...space,
		id: "s1",
		root: "Team",
	}));
	const plugin = {
		app: { metadataCache: { getFileCache: () => ({}) } },
		settings: { liveEditing: all.liveEditing },
		realtime: {
			hub: { statusOf: () => all.status },
			people: { unreadable: () => all.unreadable },
			live: {
				noteState: () =>
					(all.room && "live") ||
					(all.joining && "joining") ||
					(all.unanswered && "unanswered") ||
					all.cold,
			},
		},
	} as unknown as PluginHost;
	const view = Object.assign(Object.create(MarkdownView.prototype), {
		getViewType: () => "markdown",
		getMode: () => "source",
	}) as FileView;
	return liveStatusOf(plugin, view, file, spaceOf(partition, file.path));
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

	it("warns about a different passphrase on a live note instead of calling it offline", () => {
		expect(statusOf({ unreadable: true, room: true })).toEqual({
			state: "warning",
			label: UNREADABLE_TEXT,
		});
		expect(statusOf({ unreadable: true })?.state).toBe("cold");
	});

	it("leaves saying read-only to the lock", () => {
		const reader = (facts: Partial<Facts>) =>
			statusOf({ ...facts, spaces: [{ readOnly: true }] }, note("Team/a.md"));
		const labels = [
			reader({ room: true }),
			reader({ cold: "read-only" }),
			reader({ cold: "empty" }),
			reader({ cold: "diverged" }),
		].map((status) => status?.label);

		for (const label of labels) expect(label).not.toMatch(/read-only/i);
	});

	it("is live once its room answered", () => {
		expect(statusOf({ room: true })?.state).toBe("live");
	});

	it("gives up on a room that never answers, with its own label", () => {
		const waiting = statusOf({ joining: true });
		const silent = statusOf({ unanswered: true });

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
		expect(fine).toMatch(/^Not ready yet/);
	});
});
