import { decryptJson, type EncryptionKey } from "@/core/crypto";
import { errorMessage } from "@/core/shared";
import type { ObjectStorage } from "@/features/storage";
import { REMOTE_HISTORY_LOG_KEY } from "../constants";
import { readIfChanged } from "../remote/manifest";
import { historyLogToVault } from "../remote/space-paths";
import type { HistoryLog } from "./types";

const HISTORY_LOG_VERSION = 2;

// Callers treat the log as read-only, so the cached object is handed out as is.
const validators = new WeakMap<
	ObjectStorage,
	{ etag: string; log: HistoryLog; key: EncryptionKey; root: string }
>();

/** The legacy change log (`history.json.enc`): read to import it, and until then deep clean keeps what it names. */
export async function readHistoryLog(
	storage: ObjectStorage,
	key: EncryptionKey,
	root: string,
): Promise<HistoryLog> {
	const cached = validators.get(storage);
	const validator =
		cached?.key === key && cached.root === root ? cached : undefined;
	const read = await readIfChanged(
		storage,
		REMOTE_HISTORY_LOG_KEY,
		validator?.etag ?? null,
	);
	if (read.status === "unchanged") {
		// Only an answer about the validator we sent; otherwise it describes nothing we hold.
		if (!validator) {
			throw new Error(
				"Storage answered 'not modified' to a read that carried no validator.",
			);
		}
		return validator.log;
	}
	validators.delete(storage);
	if (read.status === "absent") {
		// Read as empty, a log that is there gets rewritten from scratch or its blobs cleaned: ask twice.
		if (await storage.exists(REMOTE_HISTORY_LOG_KEY)) {
			throw new Error(
				"History log is there but could not be read; refusing to reset it.",
			);
		}
		return { version: HISTORY_LOG_VERSION, snapshots: [], changes: {} };
	}
	let parsed: HistoryLog;
	try {
		parsed = await decryptJson<HistoryLog>(key, read.body);
	} catch (err) {
		// Present but unreadable (corruption, key rotation). Failing loudly beats
		// returning a fresh log, which would overwrite the real one and orphan history.
		throw new Error(
			`History log present but unreadable; refusing to reset it: ${errorMessage(err)}`,
		);
	}
	if (!Array.isArray(parsed.snapshots) || !isRecord(parsed.changes)) {
		throw new Error("History log is malformed; refusing to reset it.");
	}
	// Rewritten as ours, a newer client's log would lose what it added.
	if (parsed.version > HISTORY_LOG_VERSION) {
		throw new Error("History log is from a newer MDSync; update the plugin.");
	}
	const log = historyLogToVault(parsed, root);
	if (read.etag) {
		validators.set(storage, { etag: read.etag, log, key, root });
	}
	return log;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
