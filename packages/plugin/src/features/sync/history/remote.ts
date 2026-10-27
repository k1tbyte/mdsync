import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { decryptJson, type EncryptionKey, encryptJson } from "@/core/crypto";
import { runWithConcurrency } from "@/core/utils";
import type { ListedObject, ObjectStorage } from "@/features/storage";
import { REMOTE_HISTORY_PREFIX } from "../constants";
import { changesToSpace, changesToVault } from "../remote/space-paths";
import type { HistoryView } from "./model/cover";
import { RESOLUTIONS } from "./model/periods";
import type { HistoryObject, PushRecord } from "./model/types";

const PUSHES = `${REMOTE_HISTORY_PREFIX}p/`;
const OBJECTS = `${REMOTE_HISTORY_PREFIX}b/`;

type Decoded = { push: PushRecord } | { object: HistoryObject };

export interface HistoryRead {
	view: HistoryView;
	/** Listed but undecodable (corrupt, newer format): readers show a gap, GC must not run on it. */
	unreadable: string[];
	/** Storage time: the newest write listed. */
	now: number;
}

// Push records never change and objects are named by their content, so a decoded key stays valid.
const caches = new WeakMap<
	ObjectStorage,
	{ key: EncryptionKey; root: string; entries: Map<string, Decoded> }
>();

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

/** Lists `history/` once and decodes only what this session has not seen. */
export async function readHistory(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<HistoryRead> {
	let cache = caches.get(storage);
	if (cache?.key !== key || cache.root !== root) {
		cache = { key, root, entries: new Map() };
		caches.set(storage, cache);
	}
	const { entries } = cache;
	let listed = await listHistory(storage);
	let read = await decodeNew(storage, key, root, listed, entries);
	// Retired by a GC after our listing: what replaced it is listed now.
	if (read.gone > 0) {
		listed = await listHistory(storage);
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
	};
}

async function listHistory(storage: ObjectStorage): Promise<ListedObject[]> {
	const listed = storage.listDetailed
		? await storage.listDetailed(REMOTE_HISTORY_PREFIX)
		: (await storage.list(REMOTE_HISTORY_PREFIX)).map((key) => ({
				key,
				etag: null,
				modified: null,
			}));
	return listed.filter(
		({ key }) => key.startsWith(PUSHES) || key.startsWith(OBJECTS),
	);
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
	const raw = await decryptJson<Record<string, unknown>>(key, blob);
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
		!Array.isArray(object.consumed)
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
