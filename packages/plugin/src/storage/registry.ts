import type { ObsidianProtocolData } from "obsidian";

import { createGoogleDriveAdapter } from "./adapters/google-drive";
import {
	defaultGoogleDriveConfig,
	describeGoogleDriveTarget,
	GOOGLE_DRIVE_FIELDS,
	googleDriveIdentity,
	handleGoogleDriveProtocol,
	isGoogleDriveConfigured,
} from "./adapters/google-drive-auth";
import {
	createS3Adapter,
	defaultS3Config,
	describeS3Target,
	isS3Configured,
	S3_FIELDS,
	s3Identity,
} from "./adapters/s3";
import {
	createWebDAVAdapter,
	defaultWebDAVConfig,
	describeWebDAVTarget,
	isWebDAVConfigured,
	WEBDAV_FIELDS,
	webdavIdentity,
} from "./adapters/webdav";
import { EStorageBackend, type StorageAdapterConfig } from "./config";
import type { SettingsFieldSpec } from "./field-spec";
import type { StorageAdapter, StorageAuthOutcome } from "./types";

export interface StorageDescriptor<
	T extends StorageAdapterConfig = StorageAdapterConfig,
> {
	label: string;
	defaults: () => T;
	create: (config: T, onConfigChanged?: () => void) => StorageAdapter;
	isConfigured: (config: T) => boolean;
	describeTarget: (config: T) => string;
	identity: (config: T) => string;
	fields: ReadonlyArray<SettingsFieldSpec>;
	/** Returns false when not this backend's to handle. */
	handleProtocol?: (
		params: ObsidianProtocolData,
		config: T,
		saveCallback: () => Promise<void>,
	) => Promise<StorageAuthOutcome | false>;
}

const STORAGE_REGISTRY: {
	[K in EStorageBackend]: StorageDescriptor<
		Extract<StorageAdapterConfig, { kind: K }>
	>;
} = {
	[EStorageBackend.S3]: {
		label: "S3-compatible",
		defaults: defaultS3Config,
		create: createS3Adapter,
		isConfigured: isS3Configured,
		describeTarget: describeS3Target,
		identity: s3Identity,
		fields: S3_FIELDS,
	},
	[EStorageBackend.WebDAV]: {
		label: "WebDAV",
		defaults: defaultWebDAVConfig,
		create: createWebDAVAdapter,
		isConfigured: isWebDAVConfigured,
		describeTarget: describeWebDAVTarget,
		identity: webdavIdentity,
		fields: WEBDAV_FIELDS,
	},
	[EStorageBackend.GoogleDrive]: {
		label: "Google Drive",
		defaults: defaultGoogleDriveConfig,
		create: createGoogleDriveAdapter,
		isConfigured: isGoogleDriveConfigured,
		describeTarget: describeGoogleDriveTarget,
		identity: googleDriveIdentity,
		fields: GOOGLE_DRIVE_FIELDS,
		handleProtocol: handleGoogleDriveProtocol,
	},
};

export function getDescriptor<K extends EStorageBackend>(
	kind: K,
): StorageDescriptor<Extract<StorageAdapterConfig, { kind: K }>> {
	return STORAGE_REGISTRY[kind];
}

/** Stored settings can name a backend this build dropped; every lookup would throw. */
export function isKnownBackend(kind: string): kind is EStorageBackend {
	return Object.hasOwn(STORAGE_REGISTRY, kind);
}

/** A storage config with every field still at its adapter default dropped. */
export type CompactStorageConfig = { kind: EStorageBackend } & Record<
	string,
	unknown
>;

export function storageDefaults(
	kind: EStorageBackend,
): Record<string, unknown> {
	return getDescriptor(kind).defaults() as unknown as Record<string, unknown>;
}

export function compactStorageConfig(
	config: StorageAdapterConfig,
): CompactStorageConfig {
	const defaults = storageDefaults(config.kind);
	const compact: CompactStorageConfig = { kind: config.kind };
	for (const [key, value] of Object.entries(config)) {
		if (key === "kind") continue;
		if (defaults[key] === value) continue;
		compact[key] = value;
	}
	return compact;
}

export function listBackends(): ReadonlyArray<{
	kind: EStorageBackend;
	label: string;
}> {
	return Object.entries(STORAGE_REGISTRY).map(([kind, descriptor]) => ({
		kind: kind as EStorageBackend,
		label: descriptor.label,
	}));
}

export function createStorageAdapter(
	config: StorageAdapterConfig,
	/** Called when adapter updates config (e.g. token refresh) so caller can persist it. */
	onConfigChanged?: () => void,
): StorageAdapter {
	return getDescriptor(config.kind).create(config, onConfigChanged);
}

export function isAdapterConfigured(config: StorageAdapterConfig): boolean {
	return getDescriptor(config.kind).isConfigured(config);
}

export function describeStorageTarget(config: StorageAdapterConfig): string {
	return getDescriptor(config.kind).describeTarget(config);
}

export function storageIdentity(config: StorageAdapterConfig): string {
	return getDescriptor(config.kind).identity(config);
}
/**
 * Routes obsidian:// callbacks to the owning backend, not the active one (e.g. configuring Drive while S3
 * is active).
 */
export async function handleStorageProtocol(
	params: ObsidianProtocolData,
	getConfig: (kind: EStorageBackend) => StorageAdapterConfig | undefined,
	saveCallback: () => Promise<void>,
): Promise<StorageAuthOutcome | null> {
	for (const [kind, entry] of Object.entries(STORAGE_REGISTRY)) {
		const descriptor = entry as StorageDescriptor<StorageAdapterConfig>;
		if (!descriptor.handleProtocol) continue;
		const config = getConfig(kind as EStorageBackend);
		if (!config) continue;
		// Unrecognized callback returns false; next backend gets a chance.
		const outcome = await descriptor.handleProtocol(
			params,
			config,
			saveCallback,
		);
		if (outcome !== false) return outcome;
	}
	return null;
}
