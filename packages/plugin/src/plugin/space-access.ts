import { OWNER } from "@obsync/protocol";

import type { PassphraseManager } from "@/core";
import type { LiveKeys } from "@/crypto/live-keys";
import {
	activeStorage,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { reportWarning } from "@/shared/diagnostics";
import { shareIdentity, shareLiveKeys } from "@/spaces/access";
import { createStorageAdapter } from "@/storage";
import type { SyncController } from "@/sync/controller";
import { type Space, VAULT_SPACE } from "@/sync/space";

export interface SpaceAccessHost {
	passphrase: PassphraseManager;
	controller: SyncController;
	settings(): ObsyncSettings;
}

/** What this device holds in a space's relay channel: its keys and who it is there. */
export interface SpaceAccess {
	keys: LiveKeys;
	/** Who the relay knows this device's person as. */
	person: string;
	/** Groups and colours this device: its person in a share, the device itself in the vault. */
	key: string;
	name: string;
}

/** Live editing and presence both start here; null while the relay is off or the key out of reach. */
export function createSpaceAccess(
	host: SpaceAccessHost,
): (space: Space) => Promise<SpaceAccess | null> {
	const shareKeys = new Map<string, Promise<LiveKeys>>();
	return async (space) => {
		const settings = host.settings();
		if (!settings.realtimeSync) return null;
		if (space.root === VAULT_SPACE.root) {
			const keys = await vaultKeys(host);
			// One person across the vault: each device is told apart by its own name and colour.
			const { id, name } = host.controller.currentDevice();
			return keys && { keys, person: OWNER, key: id, name };
		}
		const record = settings.spaces.find((each) => each.id === space.id);
		if (!record || record.closed) return null;
		const memo = `${record.id}|${record.key}`;
		const keys = shareKeys.get(memo) ?? shareLiveKeys(record);
		shareKeys.set(memo, keys);
		const { person, name } = shareIdentity(record);
		return { keys: await keys, person, key: person, name };
	};
}

/** Never prompts: waits for a passphrase the sync already knows. */
async function vaultKeys(host: SpaceAccessHost): Promise<LiveKeys | null> {
	const settings = host.settings();
	if (!isStorageConfigured(settings)) return null;
	const { passphrase } = host;
	const cached = passphrase.liveKeys();
	if (cached || !passphrase.has()) return cached;
	try {
		await passphrase.resolveKey(createStorageAdapter(activeStorage(settings)));
	} catch (err) {
		reportWarning("The relay could not unlock the vault key.", err);
		return null;
	}
	return passphrase.liveKeys();
}
