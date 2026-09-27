import { sharePrefix } from "@obsync/protocol";

import { randomBytes, randomId } from "@/crypto";
import {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "@/storage";
import { bytesToBase64 } from "@/utils/base64";

import type { ShareLocation, SpaceRecord } from "./record";

const SHARE_KEY_BYTES = 32;

/** A new share of `root`, kept beside the vault in the owner's bucket. */
export function createShare(
	root: string,
	author: string,
	s3: S3StorageConfig,
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
		},
	};
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
