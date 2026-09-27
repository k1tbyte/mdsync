/**
 * Records travel through the vault's own storage, one object each, so two
 * devices adding spaces never race and no compare-and-set is needed.
 */

import { decryptJson, type EncryptionKey, encryptJson } from "@/crypto";
import { reportWarning } from "@/shared/diagnostics";
import type { ObjectStorage } from "@/storage/types";

import {
	isNewer,
	isSpaceRecord,
	mergeRecords,
	type SpaceRecord,
} from "./record";

const RECORDS_PREFIX = "spaces/";
const RECORD_SUFFIX = ".json.enc";

/** Merges the remote records into `local` and publishes what the remote lacks. */
export async function syncRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
	local: readonly SpaceRecord[],
): Promise<{ records: SpaceRecord[]; published: boolean }> {
	const remote = await readRecords(storage, key);
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
		published = true;
	}
	return { records: mergeRecords(remote, local), published };
}

async function readRecords(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<SpaceRecord[]> {
	const keys = (await storage.list(RECORDS_PREFIX)).filter((name) =>
		name.endsWith(RECORD_SUFFIX),
	);
	const records = await Promise.all(
		keys.map(async (name) => {
			const blob = await storage.get(name);
			if (!blob) return null;
			try {
				const record = await decryptJson<unknown>(key, blob);
				if (isSpaceRecord(record) && recordKey(record.id) === name) {
					return record;
				}
			} catch (err) {
				reportWarning(`Space record "${name}" is unreadable.`, err);
				return null;
			}
			reportWarning(`Space record "${name}" is malformed.`);
			return null;
		}),
	);
	return records.filter((record) => record !== null);
}

function recordKey(id: string): string {
	return `${RECORDS_PREFIX}${id}${RECORD_SUFFIX}`;
}
