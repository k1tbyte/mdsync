import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import type { CheckResult } from "@/core/settings";
import { errorMessage, reportWarning } from "@/core/shared";
import type { StorageHost } from "../host";
import {
	createStorageAdapter,
	describeStorageTarget,
	isAdapterConfigured,
} from "../registry";
import { activeStorage } from "../settings";

/**
 * Reaches the remote without a passphrase, so credentials can be checked before anything is encrypted.
 * Reads only the manifest key: absent is a healthy empty remote, anything else a real connection problem.
 */
export async function testConnection(
	plugin: StorageHost,
): Promise<CheckResult> {
	const config = activeStorage(plugin.settings);
	if (!isAdapterConfigured(config)) {
		return { ok: false, message: "This backend is not fully configured yet." };
	}
	const target = describeStorageTarget(config);
	try {
		// A test may refresh a Drive token: saved, or a rotated one is lost on restart.
		const adapter = createStorageAdapter(config, () => {
			plugin
				.saveSettings()
				.catch((err) => reportWarning("Could not save the settings.", err));
		});
		const found = await adapter.exists(REMOTE_MANIFEST_KEY);
		return {
			ok: true,
			message: found
				? `Connected to ${target}. A vault is already published there.`
				: `Connected to ${target}. No vault published yet - your first push will create one.`,
		};
	} catch (err) {
		return {
			ok: false,
			message: `Could not reach ${target}: ${errorMessage(err)}`,
		};
	}
}
