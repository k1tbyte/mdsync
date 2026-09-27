import { type EncryptionKey, importAesKey } from "@/crypto";
import {
	createBrokerAdapter,
	createStorageAdapter,
	type StorageAdapter,
	type StorageAdapterConfig,
} from "@/storage";
import { base64ToBytes } from "@/utils/base64";

import { ownerStorageConfig } from "./owner";
import type { SpaceRecord } from "./record";

export interface ShareStorage {
	/** Equal while the adapter can be reused: its manifest caches hold vault paths, so the root counts. */
	memo: string;
	concurrency: number;
	create(): StorageAdapter;
}

/**
 * The owner reaches a share with the device's own S3 credentials, a
 * participant through the owner's relay. Null when this device cannot.
 * `root` is where the folder is on this device, which a pending move keeps apart from the record's.
 */
export function shareStorage(
	record: SpaceRecord,
	active: StorageAdapterConfig,
	root: string,
): ShareStorage | null {
	const { access } = record;
	const { concurrency } = active;
	if (access.kind === "participant") {
		return {
			memo: JSON.stringify([root, access]),
			concurrency,
			create: () => createBrokerAdapter(record.id, access),
		};
	}
	const config = ownerStorageConfig(record.id, access.location, active);
	if (!config) return null;
	return {
		memo: JSON.stringify([root, config]),
		concurrency,
		create: () => createStorageAdapter(config),
	};
}

export function shareKey(record: SpaceRecord): Promise<EncryptionKey> {
	return importAesKey(base64ToBytes(record.key));
}
