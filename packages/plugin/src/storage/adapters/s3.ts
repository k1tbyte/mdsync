import { DEFAULT_CONCURRENCY } from "@/constants";
import { normalizeKeyPrefix } from "@/shared/path";
import { EStorageBackend, type S3StorageConfig } from "@/storage/config";
import {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "@/storage/field-spec";
import type { StorageAdapter } from "@/storage/types";

import { createS3Signer } from "./s3-signer";
import { createS3Store } from "./s3-store";

export const S3_FIELDS: ReadonlyArray<SettingsFieldSpec> = [
	{
		kind: EFieldKind.Text,
		key: "endpoint",
		name: "Endpoint",
		desc: "Base URL of the S3-compatible service. Leave empty for AWS S3.",
		placeholder: "https://s3.example.com",
	},
	{ kind: EFieldKind.Text, key: "region", name: "Region" },
	{ kind: EFieldKind.Text, key: "bucket", name: "Bucket" },
	{
		kind: EFieldKind.Text,
		key: "prefix",
		name: "Prefix",
		desc: "Optional path prefix inside the bucket. Use a separate prefix per vault.",
		placeholder: "vaults/my-vault",
	},
	{ kind: EFieldKind.Text, key: "accessKeyId", name: "Access key ID" },
	{
		kind: EFieldKind.Password,
		key: "secretAccessKey",
		name: "Secret access key",
	},
	{
		kind: EFieldKind.Toggle,
		key: "forcePathStyle",
		name: "Force path-style URLs",
		desc: "Required for most non-AWS S3 backends.",
	},
	CONCURRENCY_FIELD,
];

export function defaultS3Config(): S3StorageConfig {
	return {
		kind: EStorageBackend.S3,
		endpoint: "",
		region: "auto",
		bucket: "",
		prefix: "",
		accessKeyId: "",
		secretAccessKey: "",
		forcePathStyle: true,
		concurrency: DEFAULT_CONCURRENCY,
	};
}

export function isS3Configured(config: S3StorageConfig): boolean {
	return Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
}

export function s3Identity(config: S3StorageConfig): string {
	return `s3|${config.endpoint}|${config.region}|${config.bucket}|${config.prefix}`;
}

export function describeS3Target(config: S3StorageConfig): string {
	const bucket = config.bucket || "(not configured)";
	const prefix = config.prefix || "(bucket root)";
	return `S3 bucket: ${bucket} / prefix: ${prefix}`;
}

export function createS3Adapter(config: S3StorageConfig): StorageAdapter {
	assertConfig(config);
	const prefix = normalizeKeyPrefix(config.prefix);
	return createS3Store({
		identity: s3Identity(config),
		sign: createS3Signer(config),
		key: (key) => `${prefix}${key}`,
		relative: (key) => relativeKey(key, prefix),
	});
}

function assertConfig(config: S3StorageConfig): void {
	if (!config.bucket) throw new Error("S3 bucket is not configured");
	if (!config.accessKeyId || !config.secretAccessKey) {
		throw new Error("S3 credentials are not configured");
	}
}

function relativeKey(key: string, prefix: string): string {
	if (!prefix) return key;
	return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}
