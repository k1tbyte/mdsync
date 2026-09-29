import type { FileView, TFile } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { spaceOf } from "@/sync/space";

import { type LiveStatus, liveStatusOf } from "./live-status";

export interface HeaderState {
	status: LiveStatus | null;
	here: readonly Person[];
	/** In a read-only share, so the editor takes no typing. */
	locked: boolean;
}

export function headerStateOf(
	plugin: PluginHost,
	view: FileView,
	file: TFile,
): HeaderState {
	return {
		status: liveStatusOf(plugin, view, file),
		here: plugin.realtime.people.inNote(file.path),
		locked: spaceOf(plugin.spaces.partition(), file.path).readOnly === true,
	};
}
