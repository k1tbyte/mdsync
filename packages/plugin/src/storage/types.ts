/** Outcome of a revalidated read. `unchanged` means the body was not sent. */
export type ConditionalRead =
	| { status: "unchanged" }
	| { status: "found"; body: Uint8Array; etag: string | null }
	| { status: "absent" };

export class StorageRequestError extends Error {
	constructor(
		message: string,
		readonly userMessage: string,
	) {
		super(message);
		this.name = "StorageRequestError";
	}
}

/** The share broker refused this person's link: revoked, or too new for the relay to know yet. */
export class ShareRefusedError extends StorageRequestError {
	override name = "ShareRefusedError";
}

/** An object as a listing reports it. Null means the backend did not say. */
export interface ListedObject {
	key: string;
	etag: string | null;
	/** Last write, epoch ms. */
	modified: number | null;
}

export interface ObjectStorage {
	exists(key: string): Promise<boolean>;
	/** Bytes, or null only when genuinely absent. Any other failure throws, preventing mistaking outage for empty remote. */
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Reads only if the validator no longer matches, and reports the new one.
	 * Optional: a backend with no validator to offer leaves it out and callers
	 * fall back to {@link get}.
	 */
	getIfChanged?(key: string, etag: string | null): Promise<ConditionalRead>;
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	/**
	 * Writes only if absent; returns false if present. Prevents concurrent onboarding devices from overwriting each other's data key.
	 */
	putIfAbsent(
		key: string,
		body: Uint8Array,
		contentType?: string,
	): Promise<boolean>;
	delete(key: string): Promise<void>;
	/** List all object keys matching the prefix. Returned keys are guaranteed to start with the prefix. */
	list(prefix: string): Promise<string[]>;
	/**
	 * {@link list} with each object's validator and last write, from the same
	 * request. A validator that is unchanged means the bytes are. Optional: a
	 * backend without it leaves it out and callers read every object.
	 */
	listDetailed?(prefix: string): Promise<ListedObject[]>;
	/**
	 * A hint that these objects are about to be read, in this order, so a backend
	 * that signs each request may sign them in batches. Never needed for
	 * correctness; replaces an earlier hint.
	 */
	prepareReads?(keys: string[]): void;
	/** Lazy write-signing hint; never needed for correctness. */
	prepareWrites?(keys: string[]): void;
}

export interface StorageAdapter extends ObjectStorage {
	identity(): string;
}

/** Result of an obsidian:// auth callback, for the caller to surface. */
export interface StorageAuthOutcome {
	ok: boolean;
	message: string;
	detail?: string;
}
