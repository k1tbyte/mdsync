export {
	DEFAULT_GDRIVE_AUTH_SERVER,
	defaultGoogleDriveConfig,
	googleLoginUrl,
} from "./adapters/google-drive-auth";
export { defaultS3Config } from "./adapters/s3";
export {
	type BrokerAccess,
	type BrokerAdmin,
	createBrokerAdapter,
	endShare,
	issueShareToken,
	leaveShare,
	listParticipants,
	type Participant,
	registerShareStorage,
	revokeParticipant,
} from "./adapters/share-broker";
export { defaultWebDAVConfig } from "./adapters/webdav";
export {
	EStorageBackend,
	type GoogleDriveStorageConfig,
	type S3StorageConfig,
	type StorageAdapterConfig,
	type WebDAVStorageConfig,
} from "./config";
export {
	CONCURRENCY_FIELD,
	EFieldKind,
	type SettingsFieldSpec,
} from "./field-spec";
export {
	type CompactStorageConfig,
	compactStorageConfig,
	createStorageAdapter,
	describeStorageTarget,
	getDescriptor,
	handleStorageProtocol,
	isAdapterConfigured,
	isKnownBackend,
	listBackends,
	storageDefaults,
	storageIdentity,
} from "./registry";
export type {
	ObjectStorage,
	StorageAdapter,
	StorageAuthOutcome,
} from "./types";
export { ShareRefusedError, StorageRequestError } from "./types";
