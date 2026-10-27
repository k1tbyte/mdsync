import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptJson, type EncryptionKey } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import { REMOTE_HISTORY_LOG_KEY, REMOTE_PINS_PREFIX } from "../constants";

/**
 * Deletes 1.x history, which nothing reads past the v3 fence: its pins, then the `history.json.enc` log. Pins
 * are scanned even without the log: an interrupted reset can leave them, and one blocks every sweep.
 */
export async function clearLegacyHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<number> {
	let removed = 0;
	await runWithConcurrency(
		await storage.list(REMOTE_PINS_PREFIX),
		DEFAULT_CONCURRENCY,
		async (pin) => {
			if (!(await isLegacyPin(storage, key, pin))) return;
			await storage.delete(pin);
			removed++;
		},
	);
	if (await storage.exists(REMOTE_HISTORY_LOG_KEY)) {
		await storage.delete(REMOTE_HISTORY_LOG_KEY);
		removed++;
	}
	return removed;
}

/** A 1.x pin is a bare manifest, a current one wraps it; one that does not decrypt is unknown and stays. */
async function isLegacyPin(
	storage: ObjectStorage,
	key: EncryptionKey,
	pin: string,
): Promise<boolean> {
	const blob = await storage.get(pin);
	const raw =
		blob &&
		(await decryptJson<{ snapshotId?: unknown }>(key, blob).catch(() => null));
	return typeof raw?.snapshotId === "string";
}
