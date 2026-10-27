export { defaultS3Config } from "./backends/s3";
export {
	endpointUrl,
	type S3Method,
	type S3RequestInput,
	signingRegion,
} from "./backends/s3-signer";
export { createS3Store } from "./backends/s3-store";
export {
	errorCode,
	isRefusedCredentials,
	StorageHttpError,
} from "./backends/util";
export {
	accountsOf,
	type CloudflareLogin,
	cloudflareErrorMessage,
	cloudflareOf,
	connectCloudflare,
	forgetCloudflare,
} from "./cloudflare/cloudflare-login";
export { R2NotEnabledError, r2DashboardUrl } from "./cloudflare/r2";
export { r2StorageOf, useR2 } from "./cloudflare/r2-select";
export {
	EStorageBackend,
	type S3StorageConfig,
	type StorageAdapterConfig,
} from "./config";
export { CONCURRENCY_FIELD } from "./field-spec";
export {
	type RecordKind,
	readRecords,
	removeRecord,
	writeRecord,
} from "./records";
export {
	type CompactStorageConfig,
	compactStorageConfig,
	createStorageAdapter,
	describeStorageTarget,
	getDescriptor,
	handleStorageProtocol,
	isAdapterConfigured,
	isKnownBackend,
	storageDefaults,
	storageIdentity,
} from "./registry";
export {
	activeStorage,
	isStorageConfigured,
	parseStorageSettings,
} from "./settings";
export {
	type ConditionalRead,
	type ObjectStorage,
	ShareRefusedError,
	type StorageAdapter,
	StorageRequestError,
} from "./types";
export { backendSection } from "./ui/backend-section";
export { testConnection } from "./ui/connection-test";
export { openStorageRefusedModal } from "./ui/storage-refused-modal";
