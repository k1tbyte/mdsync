/**
 * Records travel through the vault's own storage, one object each, so two devices adding records never race
 * and no compare-and-set is needed.
 */

import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptJson, type EncryptionKey, encryptJson } from "@/core/crypto";
import { reportWarning } from "@/core/shared";
import { runWithConcurrency } from "@/core/utils";

import type { ListedObject, ObjectStorage } from "./types";

/** One kind of record: `<prefix><id>.json.enc`, sealed with the vault key. */
export interface RecordKind<T extends { id: string }> {
	prefix: string;
	parse(value: unknown): T | null;
	/** Names the kind in warnings. */
	label: string;
}

const RECORD_SUFFIX = ".json.enc";

/** Keyed by the etag of the bytes that were read, which a listing may run ahead of or behind. */
type RecordCache = Map<string, { etag: string; record: { id: string } }>;

// The storage lives as long as its settings; a new key or storage starts cold. One cache per kind, so one
// listing never prunes another's.
const caches = new WeakMap<
	ObjectStorage,
	Map<string, { key: EncryptionKey; records: RecordCache }>
>();

/** `unreadable`: ids of records listed but not decoded. */
export async function readRecords<T extends { id: string }>(
	storage: ObjectStorage,
	key: EncryptionKey,
	kind: RecordKind<T>,
): Promise<{ records: T[]; unreadable: Set<string> }> {
	const cache = cacheFor(storage, key, kind);
	const listed = (await listRecords(storage, kind.prefix)).filter(
		({ key: name }) => name.endsWith(RECORD_SUFFIX),
	);
	const names = new Set(listed.map(({ key: name }) => name));
	for (const name of cache.keys()) {
		if (!names.has(name)) cache.delete(name);
	}
	const unreadable = new Set<string>();
	const records: Array<T | null> = [];
	await runWithConcurrency(
		listed,
		DEFAULT_CONCURRENCY,
		async ({ key: name, etag }, index) => {
			const held = cache.get(name);
			if (etag !== null && held?.etag === etag) {
				records[index] = held.record as T;
				return;
			}
			const read = await readObject(storage, name, etag);
			if (!read) return;
			const record = await decodeRecord(key, kind, name, read.body);
			if (!record) unreadable.add(idOf(kind, name));
			else if (read.etag !== null) {
				cache.set(name, { etag: read.etag, record });
			}
			records[index] = record;
		},
	);
	return {
		records: records.filter((record) => record !== null),
		unreadable,
	};
}

export async function writeRecord<T extends { id: string }>(
	storage: ObjectStorage,
	key: EncryptionKey,
	kind: RecordKind<T>,
	record: T,
): Promise<void> {
	const name = recordName(kind, record.id);
	await storage.put(
		name,
		await encryptJson(key, record),
		"application/octet-stream",
	);
	// Its listing etag is not known until the next list, which reads it once.
	caches.get(storage)?.get(kind.prefix)?.records.delete(name);
}

/** By its name, listed or not: a listing that lags must not keep a record alive. */
export async function removeRecord<T extends { id: string }>(
	storage: ObjectStorage,
	kind: RecordKind<T>,
	id: string,
): Promise<void> {
	const name = recordName(kind, id);
	await storage.delete(name);
	caches.get(storage)?.get(kind.prefix)?.records.delete(name);
}

function cacheFor<T extends { id: string }>(
	storage: ObjectStorage,
	key: EncryptionKey,
	kind: RecordKind<T>,
): RecordCache {
	let kinds = caches.get(storage);
	if (!kinds) {
		kinds = new Map();
		caches.set(storage, kinds);
	}
	const held = kinds.get(kind.prefix);
	if (held?.key === key) return held.records;
	const records: RecordCache = new Map();
	kinds.set(kind.prefix, { key, records });
	return records;
}

async function listRecords(
	storage: ObjectStorage,
	prefix: string,
): Promise<ListedObject[]> {
	if (storage.listDetailed) return storage.listDetailed(prefix);
	return (await storage.list(prefix)).map((name) => ({
		key: name,
		etag: null,
		modified: null,
	}));
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

async function decodeRecord<T extends { id: string }>(
	key: EncryptionKey,
	kind: RecordKind<T>,
	name: string,
	blob: Uint8Array,
): Promise<T | null> {
	let record: T | null;
	try {
		record = kind.parse(await decryptJson<unknown>(key, blob));
	} catch (err) {
		reportWarning(`${kind.label} "${name}" is unreadable.`, err);
		return null;
	}
	if (record && recordName(kind, record.id) === name) return record;
	reportWarning(`${kind.label} "${name}" is malformed.`);
	return null;
}

function recordName<T extends { id: string }>(
	kind: RecordKind<T>,
	id: string,
): string {
	return `${kind.prefix}${id}${RECORD_SUFFIX}`;
}

function idOf<T extends { id: string }>(
	kind: RecordKind<T>,
	name: string,
): string {
	return name.slice(kind.prefix.length, -RECORD_SUFFIX.length);
}
