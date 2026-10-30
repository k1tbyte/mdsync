import type { SettingsSyncCategories } from "@/core/settings/model";
import { SyncController } from "@/features/sync/controller";
import { pullPathsOp } from "@/features/sync/operations/pull";
import { pushPathsOp } from "@/features/sync/operations/push";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import { createScopePolicy } from "@/features/sync/scope/scope";
import {
	mergeSessionIntoLocal,
	projectSession,
} from "@/features/sync/session-state";
import type { LocalState } from "@/features/sync/types";
import { TestSession } from "./session";
export const disabled: SettingsSyncCategories = {
	coreSettings: false,
	hotkeys: false,
	pluginList: false,
	pluginConfigs: false,
	snippets: false,
	themes: false,
};
export const configFiles = [
	".obsidian/app.json",
	".obsidian/hotkeys.json",
	".obsidian/community-plugins.json",
	".obsidian/plugins/sample/data.json",
	".obsidian/snippets/sample.css",
	".obsidian/themes/sample/theme.css",
];
export const enabled = Object.fromEntries(
	Object.keys(disabled).map((key) => [key, true]),
) as unknown as SettingsSyncCategories;

export class Device extends TestSession {
	settingsSync = { ...disabled };
	/** Whole plugin folders, so `enabled` means everything. */
	pluginCode = true;
	override deps() {
		return {
			...super.deps(),
			scope: createScopePolicy({
				settingsSync: this.settingsSync,
				pluginCode: this.pluginCode,
				configDir: ".obsidian",
			}),
		};
	}
	async push() {
		const result = await this.compare();
		return pushPathsOp(
			this.deps(),
			result,
			result.diff.localChanges.map((change) => change.path),
			this.context(),
		);
	}
	async pull() {
		const result = await this.compare();
		return pullPathsOp(
			this.deps(),
			result,
			result.diff.remoteChanges.map((change) => change.path),
			this.context(),
		);
	}
}

/** Drives a device through the controller, persisting state the way the plugin does. */
export function controllerFor(device: Device): SyncController {
	let local: LocalState = mergeSessionIntoLocal(
		{ deviceId: device.state.deviceId, hashCache: {}, storages: {} },
		device.state,
		device.storage.identity(),
		VAULT_SPACE,
	);
	return new SyncController({
		spaces: async () => [VAULT_SPACE],
		openSession: async () => device.deps(),
		getState: () => local,
		persistState: async (state) => {
			local = state;
			device.state = projectSession(state, device.storage.identity(), "");
		},
		logInfo: async () => {},
		logWarn: async () => {},
		logError: async () => {},
	});
}
