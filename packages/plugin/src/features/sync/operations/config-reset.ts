import { ESyncLogOperation } from "@/core/logs";
import type { SettingsSyncCategories } from "@/core/settings";
import {
	type CompareResult,
	compare,
	type EngineDependencies,
} from "../engine";
import { untrackedDir } from "../history/changes";
import { publishManifestWithHistory } from "../history/publish";
import { reconcileBaselineResetGenerations } from "../remote/config-reset";
import { buildManifest } from "../remote/manifest";
import type { OperationContext } from "./types";

export async function runCategoryResetFlow(
	deps: EngineDependencies,
	ctx: OperationContext,
	category: keyof SettingsSyncCategories,
): Promise<{ compareResult: CompareResult }> {
	ctx.setProgress("Checking remote category…");
	const result = await compare(deps);
	const remote = result.remote;
	if (!remote) return { compareResult: result };

	const files = Object.fromEntries(
		Object.entries(remote.files).filter(
			([path]) => deps.scope.getCategory(path) !== category,
		),
	);
	const folders = (remote.folders ?? []).filter(
		(dir) => deps.scope.getCategory(`${dir}/`) !== category,
	);
	if (
		Object.keys(files).length === Object.keys(remote.files).length &&
		folders.length === (remote.folders?.length ?? 0)
	) {
		return { compareResult: result };
	}
	const manifest = buildManifest(
		deps.state.deviceId,
		deps.state.deviceName,
		remote.vaultId,
		remote,
		{ files, emptyFolders: folders },
	);
	const categoryKey = `${deps.scope.configDir}/${category}`;
	manifest.resetGenerations = {
		...remote.resetGenerations,
		[categoryKey]: (remote.resetGenerations?.[categoryKey] ?? 0) + 1,
	};
	ctx.setProgress("Clearing category on remote…");
	await publishManifestWithHistory(
		deps.storage,
		deps.key,
		deps.space.root,
		manifest,
		remote,
		deps.history,
		deps.state.baseline,
		untrackedDir(deps),
	);
	const state = {
		...deps.state,
		vaultId: remote.vaultId,
		baseline: reconcileBaselineResetGenerations(
			deps.state.baseline,
			manifest,
			deps.scope,
		),
	};
	await ctx.persistState(state);
	await ctx.logInfo(
		ESyncLogOperation.Reset,
		`Cleared ${category} on remote; local files retained.`,
	);
	return { compareResult: await compare({ ...deps, state }, manifest) };
}
