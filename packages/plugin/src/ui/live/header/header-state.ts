import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence";
import { type Space, spaceOf, VAULT_SPACE } from "@/sync/space";
import { skippedFiles, skippedText } from "@/ui/common";
import type { LiveState } from "@/ui/live/live-state";

import { type LiveStatus, liveStatusOf } from "./live-status";

const TROUBLE: ReadonlySet<LiveState> = new Set(["offline", "warning"]);

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
	const here = plugin.realtime.people.inNote(file.path);
	const status =
		skippedStatus(plugin, file) ?? liveStatusOf(plugin, view, file, space);
	return {
		view,
		file,
		space,
		state: {
			status: isQuiet(space, here, status) ? null : status,
			here,
			locked: space.readOnly === true,
		},
	};
}

/** Left out of the sync outranks how it would go live. */
function skippedStatus(plugin: PluginHost, file: TFile): LiveStatus | null {
	const skipped = skippedFiles(plugin.controller).find(
		({ path }) => path === file.path,
	);
	if (!skipped) return null;
	return {
		state: "warning",
		label: skippedText(skipped, plugin.settings.maxFileBytes),
	};
}

/** A vault note is live only between this person's devices: a mark there read as shared. */
function isQuiet(
	space: Space,
	here: readonly Person[],
	status: LiveStatus | null,
): boolean {
	if (space.id !== VAULT_SPACE.id || here.length > 0 || !status) return false;
	return !TROUBLE.has(status.state);
}

export function showsHeader({ status, here, locked }: HeaderState): boolean {
	return status !== null || here.length > 0 || locked;
}
