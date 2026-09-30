import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence";
import { type Space, spaceOf } from "@/sync/space";

import { type LiveStatus, liveStatusOf } from "./live-status";

export interface HeaderState {
	status: LiveStatus | null;
	here: readonly Person[];
	/** In a read-only share. */
	locked: boolean;
}

interface Header {
	view: FileView;
	file: TFile;
	space: Space;
	state: HeaderState;
}

export function headerOf(
	plugin: PluginHost,
	leaf: WorkspaceLeaf,
): Header | null {
	const { view } = leaf;
	if (!(view instanceof FileView) || !view.navigation || !view.file) {
		return null;
	}
	const { file } = view;
	const space = spaceOf(plugin.spaces.partition(), file.path);
	return {
		view,
		file,
		space,
		state: {
			status: liveStatusOf(plugin, view, file, space),
			here: plugin.realtime.people.inNote(file.path),
			locked: space.readOnly === true,
		},
	};
}

export function showsHeader({ status, here, locked }: HeaderState): boolean {
	return status !== null || here.length > 0 || locked;
}
