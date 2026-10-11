import type { EncryptionKey } from "@/crypto";
import { type RecordKind, readRecords, writeRecord } from "@/storage/records";
import type { ObjectStorage } from "@/storage/types";
import { isNewer } from "@/utils";

import { isSpaceRecord, mergeRecords, type SpaceRecord } from "./record";

const SPACES: RecordKind<SpaceRecord> = {
	prefix: "spaces/",
	parse: (value) => (isSpaceRecord(value) ? value : null),
	label: "Space record",
};

/**
 * Merges the remote records into `local` and publishes what the remote lacks; `unbound`: `local` was made
 * before this device knew this vault.
 */
export async function syncRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
	local: readonly SpaceRecord[],
	unbound = false,
): Promise<{ records: SpaceRecord[]; published: boolean }> {
	const { records: remote, unreadable } = await readRecords(
		storage,
		key,
		SPACES,
	);
	const theirs = new Map(remote.map((record) => [record.id, record]));
	// Unbound: the vault's own share stays its owner's; a join outranks its older close, as `acceptInvite` does.
	const mine = local.map((record) => {
		const known = theirs.get(record.id);
		if (!unbound || !known) return record;
		if (known.access.kind === "owner" && record.access.kind === "participant") {
			return known;
		}
		return known.closed && !record.closed
			? { ...record, rev: known.rev + 1 }
			: record;
	});
	let published = false;
	for (const record of mine) {
		// One this device cannot read may be newer, or of a newer format: never written over.
		if (unreadable.has(record.id)) continue;
		const known = theirs.get(record.id);
		if (known && !isNewer(record, known)) continue;
		await writeRecord(storage, key, SPACES, record);
		published = true;
	}
	return { records: mergeRecords(remote, mine), published };
}

export async function fetchRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<SpaceRecord[]> {
	return (await readRecords(storage, key, SPACES)).records;
}
