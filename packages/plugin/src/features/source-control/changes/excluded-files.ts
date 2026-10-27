import { TFolder } from "obsidian";

import type { PluginHost } from "@/app/host";
import { formatBytes } from "@/core/shared";
import type { SkippedFile } from "@/features/sync/types";
import { stopIgnoring } from "@/features/sync/ui/ignore-action";
import { type FileGroup, FileListModal } from "./file-list-modal";

/** What the vault's and this device's ignore rules keep out, by where the rule lives. */
export function showIgnoredFiles(
	plugin: PluginHost,
	paths: readonly string[],
): void {
	const { ignoreState } = plugin;
	// A rule dropped since the compare: no longer ignored.
	const ignored = paths.filter((path) => ignoreState.isIgnored(path));
	const local = new Set(
		ignored.filter(
			(path) =>
				ignoreState.isIgnoredLocally(path) &&
				!ignoreState.isIgnoredGlobally(path),
		),
	);
	const shared = ignored.filter((path) => !local.has(path));
	const groups: FileGroup[] = [
		{
			title: "All devices",
			hint: "Kept out everywhere by the rules in syncignore.md.",
			files: shared.map((path) => ({ path })),
		},
		{
			title: "This device",
			hint: "Kept out here by the ignore patterns in MDSync settings.",
			files: [...local].map((path) => ({ path })),
		},
	];
	new FileListModal(
		plugin.app,
		{
			icon: "eye-off",
			title: "Ignored files",
			sub: "Never compared or synced",
		},
		groups,
		{
			title: "Stop ignoring",
			icon: "eye",
			run: async (path) => {
				const folder =
					plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder;
				await stopIgnoring(plugin, path, folder);
				return !ignoreState.isIgnored(path);
			},
		},
	).open();
}

/** Files this device cannot sync, by why. */
export function showSkippedFiles(
	plugin: PluginHost,
	skipped: readonly SkippedFile[],
): void {
	const of = <R extends SkippedFile["reason"]>(reason: R) =>
		skipped.filter(
			(file): file is Extract<SkippedFile, { reason: R }> =>
				file.reason === reason,
		);
	const max = formatBytes(plugin.settings.maxFileBytes);
	const groups: FileGroup[] = [
		{
			title: "Too large",
			hint: `Over the ${max} limit. Raise Max file size in MDSync settings to sync them.`,
			files: of("too-large").map(({ path, size }) => ({
				path,
				aside: formatBytes(size),
			})),
		},
		{
			title: "Name clash",
			hint: "Their names differ from another file's only in case, which this system cannot keep apart.",
			files: of("case-clash").map(({ path, other }) => ({
				path,
				detail: `Clashes with ${other}`,
			})),
		},
		{
			title: "Name not allowed here",
			hint: 'A character this system refuses, such as : ? * " < > |. Rename them on the device that has them.',
			files: of("reserved-name").map(({ path }) => ({ path })),
		},
		{
			title: "Could not be read",
			files: of("unreadable").map(({ path, detail }) => ({ path, detail })),
		},
	];
	new FileListModal(
		plugin.app,
		{
			icon: "cloud-off",
			title: "Not synced",
			sub: "These stay on this device only",
		},
		groups,
	).open();
}
