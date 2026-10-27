import type { PluginHost } from "@/app/host";
import { notifyError, notifyInfo, runWithNotice } from "@/core/ui";
import { openSourceControlChanges } from "@/features/source-control/view";
import type { DiffResult } from "../types";

export async function runCompare(plugin: PluginHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		await openSourceControlChanges(plugin);
	} catch (err) {
		notifyError("Compare failed", err);
	}
}

export async function runPushAll(plugin: PluginHost): Promise<void> {
	try {
		// Re-compare first: a stale diff can push a file another device changed, or miss conflicts.
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff.conflicts.length))) {
			return;
		}
		// A read-only share's changes cannot go out; they must not hold back the rest.
		const paths = diff.localChanges
			.map((c) => c.path)
			.filter((path) => !plugin.controller.spaceFor(path).readOnly);
		if (paths.length === 0) {
			notifyInfo("Nothing to push.");
			return;
		}
		await runWithNotice(
			() => plugin.controller.pushPaths(paths),
			`Pushed ${paths.length} file(s).`,
			"Push all failed",
		);
	} catch (err) {
		notifyError("Push all failed", err);
	}
}

export async function runPullAll(plugin: PluginHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff.conflicts.length))) {
			return;
		}
		const paths = diff.remoteChanges.map((c) => c.path);
		if (paths.length === 0) {
			notifyInfo("Nothing to pull.");
			return;
		}
		await runWithNotice(
			() => plugin.controller.pullPaths(paths),
			`Pulled ${paths.length} file(s).`,
			"Pull all failed",
		);
	} catch (err) {
		notifyError("Pull all failed", err);
	}
}

/** The fresh compare's diff; null, said so, when the compare did not finish. */
function comparedDiff(plugin: PluginHost): DiffResult | null {
	const { error, result } = plugin.controller.getSnapshot();
	if (error) throw new Error(error);
	if (!result) notifyInfo("The compare did not finish. Try again.");
	return result?.diff ?? null;
}

/** Push and pull must never choose a side silently; conflicts go to the user. */
async function announceConflicts(
	plugin: PluginHost,
	count: number,
): Promise<boolean> {
	if (count === 0) return false;
	notifyInfo(`Resolve ${count} conflict(s) first.`);
	await openSourceControlChanges(plugin);
	return true;
}
