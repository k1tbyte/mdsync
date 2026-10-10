import type { EncryptionKey } from "@/crypto";
import {
	type RecordKind,
	readRecords,
	removeRecord,
	writeRecord,
} from "@/storage/records";
import type { StorageAdapter } from "@/storage/types";
import { isNewer } from "@/utils";

import {
	type LinkRecord,
	parseTradedLink,
	type StoredLink,
	tradedLink,
} from "./record";

const LINKS: RecordKind<LinkRecord> = {
	prefix: "links/",
	parse: parseTradedLink,
	label: "Share link record",
};

/**
 * Trades this device's links with the vault storage. No tombstones: a link removed on any device is deleted
 * from the storage, and a copy already traded there that the storage no longer lists was removed elsewhere.
 * A listing that lags only drops a copy the storage still holds; the next trade brings it back.
 */
export async function tradeLinks(
	storage: StorageAdapter,
	key: EncryptionKey,
	local: readonly StoredLink[],
): Promise<{ links: StoredLink[]; changed: boolean }> {
	const vault = storage.identity();
	const { records, unreadable } = await readRecords(storage, key, LINKS);
	const theirs = new Map(records.map((record) => [record.id, record]));
	const links: StoredLink[] = [];
	let changed = false;
	for (const link of local) {
		const known = theirs.get(link.id);
		theirs.delete(link.id);
		if (link.removed) {
			// Beats any revision there, readable or not. Kept until the deletion went through, so a failed one is tried again.
			await removeRecord(storage, LINKS, link.id);
			changed = true;
		} else if (unreadable.has(link.id)) {
			// May be newer, or of a newer format: never written over.
			links.push(link);
		} else if (!known && link.vault === vault) {
			// Removed on another device: the removal beats any edit made here meanwhile.
		} else if (!known || isNewer(link, known)) {
			await writeRecord(storage, key, LINKS, tradedLink(link));
			changed = true;
			links.push({ ...link, vault });
		} else if (link.vault === vault && !isNewer(known, link)) {
			// The same revision: this copy stays, so a trade that brought nothing saves nothing.
			links.push(link);
		} else {
			links.push({ ...known, vault });
		}
	}
	for (const record of theirs.values()) links.push({ ...record, vault });
	return { links, changed };
}
