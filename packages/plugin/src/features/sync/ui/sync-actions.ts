import { notifyError, notifyInfo, runWithNotice } from "@/core/ui";
import type { SyncController } from "../controller";
import type { SyncHost } from "../host";
import type { DiffResult } from "../types";

export async function runCompare(plugin: SyncHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		await plugin.openChanges();
	} catch (err) {
		notifyError("Compare failed", err);
	}
}

export async function runPushAll(plugin: SyncHost): Promise<void> {
	try {
		// Re-compare first: a stale diff can push a file another device changed, or miss conflicts.
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff))) return;
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

export async function runPullAll(plugin: SyncHost): Promise<void> {
	try {
		await plugin.controller.refresh();
		const diff = comparedDiff(plugin);
		if (!diff || (await announceConflicts(plugin, diff))) return;
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
function comparedDiff(plugin: SyncHost): DiffResult | null {
	const { error, result } = plugin.controller.getSnapshot();
	if (error) throw new Error(error);
	if (!result) notifyInfo("The compare did not finish. Try again.");
	return result?.diff ?? null;
}

/** Push and pull must never choose a side silently; conflicts go to the user. */
async function announceConflicts(
	plugin: SyncHost,
	diff: DiffResult,
): Promise<boolean> {
	if (diff.conflicts.length === 0) return false;
	notifyInfo(conflictsFirst(diff.conflicts.map((c) => c.path)));
	await plugin.openChanges();
	return true;
}

export function conflictsFirst(paths: ReadonlyArray<string>): string {
	const which =
		paths.length === 1
			? `the conflict in "${paths[0]}"`
			: `the ${paths.length} conflicts`;
	return `Resolve ${which} first: nothing pushes or pulls until then.`;
}

/** Why `paths` cannot go now, or null: an open conflict holds every push and pull of its space. */
export function heldByConflicts(
	controller: Pick<SyncController, "getSnapshot" | "spaceFor">,
	paths: ReadonlyArray<string>,
): string | null {
	const conflicts = controller.getSnapshot().result?.diff.conflicts ?? [];
	if (conflicts.length === 0) return null;
	const spaces = new Set(paths.map((path) => controller.spaceFor(path).id));
	const holding = conflicts
		.map((c) => c.path)
		.filter((path) => spaces.has(controller.spaceFor(path).id));
	return holding.length > 0 ? conflictsFirst(holding) : null;
}
