import type { LinkKeys } from "@mdsync/protocol";
import {
	createStore,
	get,
	promisifyRequest,
	set,
	type UseStore,
} from "idb-keyval";

const MS_PER_S = 1000;

/** A protected link's keys kept on this browser, so it opens without the passphrase. */
export interface RememberedKeys {
	get(id: string): Promise<LinkKeys | null>;
	/** `expires` in Unix seconds; null keeps them until the relay says the link is gone. */
	put(id: string, keys: LinkKeys, expires: number | null): Promise<void>;
	/** With `stale`, only while those are still the kept ones: another tab may have kept newer. */
	drop(id: string, stale?: LinkKeys): Promise<void>;
}

interface Entry {
	keys: LinkKeys;
	expires: number | null;
}

/**
 * IndexedDB, because a `CryptoKey` survives it: the derived key is non-extractable and the passphrase is never
 * written. Storage the browser blocks just remembers nothing.
 */
export function browserKeys(): RememberedKeys {
	let store: UseStore | undefined;
	const db = () => {
		if (!store) {
			store = createStore("mdsync-viewer", "keys");
			void sweep(store).catch(() => undefined);
		}
		return store;
	};
	const drop = async (id: string, stale?: LinkKeys) => {
		try {
			// Read and delete in one transaction, so a newer entry kept meanwhile survives.
			await db()("readwrite", (keys) => {
				const kept = keys.get(id);
				kept.onsuccess = () => {
					const entry = kept.result as Entry | undefined;
					if (!stale || entry?.keys.gate === stale.gate) keys.delete(id);
				};
				return promisifyRequest(keys.transaction);
			});
		} catch {
			// Nothing was kept.
		}
	};
	return {
		async get(id) {
			try {
				const entry = await get<Entry>(id, db());
				if (!entry) return null;
				if (expired(entry.expires)) {
					await drop(id);
					return null;
				}
				return entry.keys;
			} catch {
				return null;
			}
		},
		async put(id, keys, expires) {
			if (expired(expires)) return;
			try {
				await set(id, { keys, expires } satisfies Entry, db());
			} catch {
				// The link still opens; it asks again next time.
			}
		},
		drop,
	};
}

/** Erases the keys of every expired link, not only of the links opened again. */
function sweep(store: UseStore): Promise<void> {
	return store("readwrite", (keys) => {
		const cursors = keys.openCursor();
		cursors.onsuccess = () => {
			const cursor = cursors.result;
			if (!cursor) return;
			if (expired((cursor.value as Entry).expires)) cursor.delete();
			cursor.continue();
		};
		return promisifyRequest(keys.transaction);
	});
}

function expired(expires: number | null): boolean {
	return expires !== null && expires * MS_PER_S <= Date.now();
}
