import { sharePrefix } from "@obsync/protocol";

import { randomBytes, randomId } from "@/crypto";
import {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "@/storage";
import { bytesToBase64 } from "@/utils/base64";

import { isNewer, type ShareLocation, type SpaceRecord } from "./record";

const SHARE_KEY_BYTES = 32;

/** A new share of `root`, kept beside the vault in the owner's bucket. */
export function createShare(
	root: string,
	author: string,
	s3: S3StorageConfig,
	ownerName: string,
): SpaceRecord {
	const { endpoint, region, bucket, prefix, forcePathStyle } = s3;
	return {
		id: randomId(),
		name: root.slice(root.lastIndexOf("/") + 1),
		root,
		rev: 1,
		author,
		key: bytesToBase64(randomBytes(SHARE_KEY_BYTES)),
		access: {
			kind: "owner",
			location: { endpoint, region, bucket, prefix, forcePathStyle },
			...(ownerName ? { name: ownerName } : {}),
		},
	};
}

/** The person's name as their shares carry it, so every device of theirs shows one; "" while unset. */
export function ownerNameOf(records: readonly SpaceRecord[]): string {
	let newest: SpaceRecord | null = null;
	for (const record of ownShares(records)) {
		if (!newest || isNewer(record, newest)) newest = record;
	}
	return newest?.access.kind === "owner" ? (newest.access.name ?? "") : "";
}

/** Every open share of theirs takes the new name, each a revision on for the records' trade. */
export function renameOwner(
	records: readonly SpaceRecord[],
	name: string,
	author: string,
): SpaceRecord[] {
	const owned = new Set(ownShares(records));
	return records.map((record) =>
		owned.has(record) && record.access.kind === "owner"
			? {
					...record,
					rev: record.rev + 1,
					author,
					access: { ...record.access, name },
				}
			: record,
	);
}

function ownShares(records: readonly SpaceRecord[]): SpaceRecord[] {
	return records.filter(
		(record) => record.access.kind === "owner" && !record.closed,
	);
}

/** The share's storage under this device's own credentials; null off S3. */
export function ownerStorageConfig(
	shareId: string,
	location: ShareLocation,
	active: StorageAdapterConfig,
): S3StorageConfig | null {
	if (active.kind !== EStorageBackend.S3) return null;
	const { endpoint, region, bucket, prefix, forcePathStyle } = location;
	return {
		...active,
		endpoint,
		region,
		bucket,
		forcePathStyle,
		prefix: sharePrefix(prefix, shareId),
	};
}

/** What the relay's broker signs with: the share's base location, this device's credentials. */
export function brokerStorage(
	location: ShareLocation,
	s3: S3StorageConfig,
): S3StorageConfig {
	return { ...s3, ...location };
}
