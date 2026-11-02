import { REMOTE_MANIFEST_KEY } from "@/core/constants";
import { type EncryptionKey, encryptJson } from "@/core/crypto/cipher";
import type { ObjectStorage } from "@/features/storage/types";
import type { Manifest } from "@/features/sync/types";

export async function publishManifest(
	storage: ObjectStorage,
	key: EncryptionKey,
	manifest: Manifest,
): Promise<void> {
	const blob = await encryptJson(key, manifest);
	await storage.put(REMOTE_MANIFEST_KEY, blob, "application/octet-stream");
}
