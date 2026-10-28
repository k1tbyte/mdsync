import { DEFAULT_CONCURRENCY } from "@/core/constants";
import {
	decryptJson,
	type EncryptionKey,
	encryptJson,
	randomId,
	sha256Hex,
} from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ListedObject, ObjectStorage } from "@/features/storage";
import { REMOTE_HISTORY_PREFIX } from "../constants";
import { changesToSpace, changesToVault } from "../remote/space-paths";
import type { HistoryView } from "./model/cover";
import { RESOLUTIONS } from "./model/periods";
import type { HistoryObject, PushRecord } from "./model/types";

const PUSHES = `${REMOTE_HISTORY_PREFIX}p/`;
const OBJECTS = `${REMOTE_HISTORY_PREFIX}b/`;
/** Blobs a GC run stopped naming: held for a day, then swept. */
const CANDIDATES = `${REMOTE_HISTORY_PREFIX}g/`;

interface Candidates {
	v: 1;
	hashes: string[];
}

type Decoded = { push: PushRecord } | { object: HistoryObject };

export interface HistoryRead {
	view: HistoryView;
	/** Listed but undecodable (corrupt, newer format): readers show a gap, GC must not run on it. */
	unreadable: string[];
	/** Storage time: the newest record or object listed. */
	now: number;
	/** Candidate files, listed in the same call. */
	candidates: ListedObject[];
}

// Push records never change and objects are named by their content, so a decoded key stays valid.
const caches = new WeakMap<
	ObjectStorage,
	{ key: EncryptionKey; root: string; entries: Map<string, Decoded> }
>();

function cacheOf(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Map<string, Decoded> {
	let cache = caches.get(storage);
	if (cache?.key !== key || cache.root !== root) {
		cache = { key, root, entries: new Map() };
		caches.set(storage, cache);
	}
	return cache.entries;
}

export function pushKey(id: string): string {
	return `${PUSHES}${id}.enc`;
}

/** Sealed with space paths, so a write retried after the space moved still names the right files. */
export function sealPushRecord(
	key: EncryptionKey,
	root: string,
	record: PushRecord,
): Promise<Uint8Array> {
	return encryptJson(key, {
		...record,
		changes: changesToSpace(record.changes, root),
	});
}

/**
 * Named by its whole content, `consumed` included, so a key never changes meaning and a decoded object stays
 * valid; only a read-back under the same key proves the write. Returns the stored object, in space paths.
 */
export async function writeHistoryObject(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	build: Omit<HistoryObject, "v">,
): Promise<{ key: string; object: HistoryObject }> {
	const stored: HistoryObject = {
		v: 1,
		...build,
		records: build.records.map((record) => ({
			...record,
			changes: changesToSpace(record.changes, root),
		})),
	};
	const storageKey = await objectKeyOf(stored);
	await storage.put(
		storageKey,
		await encryptJson(key, stored),
		"application/octet-stream",
	);
	const blob = await storage.get(storageKey);
	const read = blob && (await decryptJson<HistoryObject>(key, blob));
	// decodeRaw recomputes the key from the read-back, so a null is one that is not what was written.
	const decoded = read && (await decodeRaw(root, storageKey, read));
	if (!read || !decoded) {
		throw new Error(
			`History object ${storageKey} did not read back as written.`,
		);
	}
	// Seeded from the read-back only, so the next read of this key costs no GET.
	cacheOf(storage, key, root).set(storageKey, decoded);
	return { key: storageKey, object: read };
}

async function objectKeyOf(object: HistoryObject): Promise<string> {
	const { records, activity, lastId, consumed } = object;
	const json = JSON.stringify({ records, activity, lastId, consumed });
	const digest = (await sha256Hex(new TextEncoder().encode(json))).slice(0, 16);
	return `${OBJECTS}${object.res}-${object.group}-${digest}.enc`;
}

export async function writeCandidates(
	storage: ObjectStorage,
	key: EncryptionKey,
	hashes: readonly string[],
): Promise<void> {
	const candidates: Candidates = { v: 1, hashes: [...hashes] };
	await storage.put(
		`${CANDIDATES}${randomId()}.enc`,
		await encryptJson(key, candidates),
		"application/octet-stream",
	);
}

/** A file gone meanwhile was swept by another run; one that does not decode is `unreadable`. */
export async function readCandidates(
	storage: ObjectStorage,
	key: EncryptionKey,
	files: readonly ListedObject[],
): Promise<{ hashes: Set<string>; unreadable: string[] }> {
	const hashes = new Set<string>();
	const unreadable: string[] = [];
	await runWithConcurrency(
		files,
		DEFAULT_CONCURRENCY,
		async ({ key: file }) => {
			const blob = await storage.get(file);
			if (!blob) return;
			const read = await decryptJson<Candidates>(key, blob).catch(() => null);
			if (read?.v !== 1 || !Array.isArray(read.hashes)) unreadable.push(file);
			else for (const hash of read.hashes) hashes.add(hash);
		},
	);
	return { hashes, unreadable };
}

/** Lists `history/` once and decodes only what this session has not seen. */
export async function readHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<HistoryRead> {
	const entries = cacheOf(storage, key, root);
	let all = await listHistory(storage);
	let listed = all.filter(isRecordOrObject);
	let read = await decodeNew(storage, key, root, listed, entries);
	// Retired by a GC after our listing: what replaced it is listed now.
	if (read.gone > 0) {
		all = await listHistory(storage);
		listed = all.filter(isRecordOrObject);
		read = await decodeNew(storage, key, root, listed, entries);
	}
	const times = new Map(listed.map((object) => [object.key, object.modified]));
	// Reduced, not spread: a long listing would overflow the argument stack.
	const now = listed.reduce<number | null>(
		(max, { modified }) =>
			modified === null || (max !== null && max >= modified) ? max : modified,
		null,
	);
	const newest = now ?? Date.now();
	const pushes = new Map<string, { push: PushRecord; at: number }>();
	const objects = new Map<string, { object: HistoryObject; at: number }>();
	for (const [storageKey, modified] of times) {
		const decoded = entries.get(storageKey);
		if (!decoded) continue;
		if ("push" in decoded) {
			const { parentId } = decoded.push;
			// Undated: its parent's time, else "now"; as "now" it never packs and holds up its successors.
			const parentAt = parentId === null ? null : times.get(pushKey(parentId));
			const at = modified ?? parentAt ?? newest;
			pushes.set(storageKey, { push: decoded.push, at });
		} else {
			objects.set(storageKey, {
				object: decoded.object,
				at: modified ?? newest,
			});
		}
	}
	for (const storageKey of entries.keys()) {
		if (!times.has(storageKey)) entries.delete(storageKey);
	}
	return {
		view: { pushes, objects },
		unreadable: read.unreadable,
		now: newest,
		candidates: all.filter(({ key }) => key.startsWith(CANDIDATES)),
	};
}

function isRecordOrObject({ key }: ListedObject): boolean {
	return key.startsWith(PUSHES) || key.startsWith(OBJECTS);
}

async function listHistory(storage: ObjectStorage): Promise<ListedObject[]> {
	if (storage.listDetailed) return storage.listDetailed(REMOTE_HISTORY_PREFIX);
	return (await storage.list(REMOTE_HISTORY_PREFIX)).map((key) => ({
		key,
		etag: null,
		modified: null,
	}));
}

async function decodeNew(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
	listed: readonly ListedObject[],
	entries: Map<string, Decoded>,
): Promise<{ gone: number; unreadable: string[] }> {
	const todo = listed
		.map((object) => object.key)
		.filter((storageKey) => !entries.has(storageKey));
	// An empty hint would replace one a running transfer gave.
	if (todo.length > 0) storage.prepareReads?.(todo);
	let gone = 0;
	const unreadable: string[] = [];
	await runWithConcurrency(todo, DEFAULT_CONCURRENCY, async (storageKey) => {
		const blob = await storage.get(storageKey);
		if (!blob) {
			gone++;
			return;
		}
		const decoded = await decode(key, root, storageKey, blob).catch(() => null);
		if (decoded) entries.set(storageKey, decoded);
		else unreadable.push(storageKey);
	});
	return { gone, unreadable };
}

async function decode(
	key: EncryptionKey,
	root: string,
	storageKey: string,
	blob: Uint8Array,
): Promise<Decoded | null> {
	return decodeRaw(
		root,
		storageKey,
		await decryptJson<Record<string, unknown>>(key, blob),
	);
}

/** Validates a decrypted record or object and moves its paths from space to vault. */
async function decodeRaw(
	root: string,
	storageKey: string,
	raw: { v?: unknown; vaultId?: unknown },
): Promise<Decoded | null> {
	if (raw.v !== 1 || typeof raw.vaultId !== "string") return null;
	if (storageKey.startsWith(PUSHES)) {
		const push = raw as unknown as PushRecord;
		if (typeof push.id !== "string" || !push.changes) return null;
		return {
			push: { ...push, changes: changesToVault(push.changes, root) },
		};
	}
	const object = raw as unknown as HistoryObject;
	if (
		!RESOLUTIONS.includes(object.res) ||
		!Array.isArray(object.records) ||
		!Array.isArray(object.consumed) ||
		// A key that does not match its content cannot vouch for what it consumes.
		(await objectKeyOf(object)) !== storageKey
	) {
		return null;
	}
	return {
		object: {
			...object,
			records: object.records.map((record) => ({
				...record,
				changes: changesToVault(record.changes, root),
			})),
		},
	};
}
