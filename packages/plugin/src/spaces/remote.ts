/**
 * Records travel through the vault's own storage, one object each, so two
 * devices adding spaces never race and no compare-and-set is needed.
 */

import { decryptJson, type EncryptionKey, encryptJson } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ListedObject, ObjectStorage } from "@/storage/types";

import {
	isNewer,
	isSpaceRecord,
	mergeRecords,
	type SpaceRecord,
} from "./record";

const RECORDS_PREFIX = "spaces/";
const RECORD_SUFFIX = ".json.enc";

/** Keyed by the etag of the bytes that were read, which a listing may run ahead of or behind. */
type RecordCache = Map<string, { etag: string; record: SpaceRecord }>;

// The storage lives as long as its settings; a new key or storage starts cold.
const caches = new WeakMap<
	ObjectStorage,
	{ key: EncryptionKey; records: RecordCache }
>();

/** Merges the remote records into `local` and publishes what the remote lacks. */
export async function syncRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
	local: readonly SpaceRecord[],
): Promise<{ records: SpaceRecord[]; published: boolean }> {
	const cache = cacheFor(storage, key);
	const remote = await readRecords(storage, key, cache);
	const theirs = new Map(remote.map((record) => [record.id, record]));
	let published = false;
	for (const record of local) {
		const known = theirs.get(record.id);
		if (known && !isNewer(record, known)) continue;
		await storage.put(
			recordKey(record.id),
			await encryptJson(key, record),
			"application/octet-stream",
		);
		// Its listing etag is not known until the next list, which reads it once.
		cache.delete(recordKey(record.id));
		published = true;
	}
	return { records: mergeRecords(remote, local), published };
}

function cacheFor(storage: ObjectStorage, key: EncryptionKey): RecordCache {
	const held = caches.get(storage);
	if (held?.key === key) return held.records;
	const records: RecordCache = new Map();
	caches.set(storage, { key, records });
	return records;
}

async function listRecords(storage: ObjectStorage): Promise<ListedObject[]> {
	if (storage.listWithEtags) return storage.listWithEtags(RECORDS_PREFIX);
	return (await storage.list(RECORDS_PREFIX)).map((name) => ({
		key: name,
		etag: null,
	}));
}

async function readRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
	cache: RecordCache,
): Promise<SpaceRecord[]> {
	const listed = (await listRecords(storage)).filter(({ key: name }) =>
		name.endsWith(RECORD_SUFFIX),
	);
	const names = new Set(listed.map(({ key: name }) => name));
	for (const name of cache.keys()) {
		if (!names.has(name)) cache.delete(name);
	}
	const records = await Promise.all(
		listed.map(async ({ key: name, etag }) => {
			const held = cache.get(name);
			if (etag !== null && held?.etag === etag) return held.record;
			const read = await readObject(storage, name, etag);
			if (!read) return null;
			const record = await decodeRecord(key, name, read.body);
			if (record && read.etag !== null) {
				cache.set(name, { etag: read.etag, record });
			}
			return record;
		}),
	);
	return records.filter((record) => record !== null);
}

/** A backend that cannot name the version it served leaves the listing's word as the only one. */
async function readObject(
	storage: ObjectStorage,
	name: string,
	listedEtag: string | null,
): Promise<{ body: Uint8Array; etag: string | null } | null> {
	if (!storage.getIfChanged) {
		const body = await storage.get(name);
		return body && { body, etag: listedEtag };
	}
	const read = await storage.getIfChanged(name, null);
	return read.status === "found" ? read : null;
}

async function decodeRecord(
	key: EncryptionKey,
	name: string,
	blob: Uint8Array,
): Promise<SpaceRecord | null> {
	try {
		const record = await decryptJson<unknown>(key, blob);
		if (isSpaceRecord(record) && recordKey(record.id) === name) return record;
	} catch (err) {
		reportWarning(`Space record "${name}" is unreadable.`, err);
		return null;
	}
	reportWarning(`Space record "${name}" is malformed.`);
	return null;
}

function recordKey(id: string): string {
	return `${RECORDS_PREFIX}${id}${RECORD_SUFFIX}`;
}
