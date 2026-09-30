import {
	type CachedMetadata,
	type FileView,
	MarkdownView,
	TFile,
} from "obsidian";

import type { RelayStatus } from "@/hub/status";
import type { ColdCause } from "@/live/sessions";
import type { PluginHost } from "@/plugin/host";
import type { Space } from "@/sync/space";
import { liveStatusOf } from "@/ui/live/live-status";

export interface Facts {
	status: RelayStatus;
	unreadable: boolean;
	room: boolean;
	joining: boolean;
	unanswered: boolean;
	cold: ColdCause | null;
	liveEditing: boolean;
	spaces: Space[];
	cache: CachedMetadata | null;
	viewType: string;
	mode: string;
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
	cache: {},
	viewType: "markdown",
	mode: "source",
};

export function note(path: string, size = 10): TFile {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		stat: { size },
	});
}

export function statusOf(facts: Partial<Facts> = {}, file = note("a.md")) {
	const all = { ...FACTS, ...facts };
	const plugin = {
		app: { metadataCache: { getFileCache: () => all.cache } },
		settings: { liveEditing: all.liveEditing },
		spaces: { partition: () => all.spaces },
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
	const view = Object.assign(
		Object.create(all.viewType === "markdown" ? MarkdownView.prototype : null),
		{ getViewType: () => all.viewType, getMode: () => all.mode },
	) as FileView;
	return liveStatusOf(plugin, view, file);
}
