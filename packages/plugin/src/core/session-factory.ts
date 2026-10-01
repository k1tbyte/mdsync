import { type App, TFile } from "obsidian";
import type { EncryptionKey } from "@/crypto";
import { ESyncLogOperation } from "@/logs/store";
import {
	activeStorage,
	isGuest,
	isStorageConfigured,
	type ObsyncSettings,
} from "@/settings/model";
import { reportWarning } from "@/shared";
import type { SpaceRecords } from "@/spaces";
import { pauseOf } from "@/spaces";
import { shareKey, shareStorage } from "@/spaces/access";
import { shareIdentity } from "@/spaces/record";
import { createStorageAdapter, type StorageAdapter } from "@/storage";
import { clearRemoteTextCache } from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import { PassphraseRotatedError } from "@/sync/keyfile";
import type { LiveNotes } from "@/sync/live-notes";
import { projectSession } from "@/sync/session-state";
import { nestedRoots, type Space, VAULT_SPACE } from "@/sync/space";
import type { ManifestAuthor } from "@/sync/types";
import { createVaultIndex } from "@/vault/file-index";
import {
	createIgnoreMatcher,
	type IgnoreMatcher,
	ignoreNoteOf,
	loadSharedIgnoreMatcher,
} from "@/vault/ignore";
import { createScopePolicy } from "@/vault/scope";
import { createSymlinkDetector } from "@/vault/symlinks";
import type { LogService } from "./log-service";
import type { PassphraseManager } from "./passphrase-manager";
import type { StatePersister } from "./state-persister";

export interface SessionFactoryDeps {
	app: App;
	settings: ObsyncSettings;
	spaces: Pick<SpaceRecords, "get">;
	passphrase: PassphraseManager;
	state: StatePersister;
	logs: LogService;
	notify: (message: string) => void;
	/** Persists settings an adapter rewrote itself, such as a refreshed token. */
	persistSettings?: () => Promise<void>;
	/** Late-bound: live editing starts after the sync it hooks into. */
	liveNotes?: (space: Space) => LiveNotes | undefined;
}

export type SessionOpener = (
	space: Space,
	partition: readonly Space[],
) => Promise<EngineDependencies | null>;

export function createSessionOpener(deps: SessionFactoryDeps): SessionOpener {
	const getScope = createScopeMatchers(deps);
	const getStorage = createAdapterCache(deps);
	return async (space, partition) => {
		const { app, settings, state } = deps;
		const opened =
			space.root === ""
				? await openVault(deps, getStorage)
				: await openShare(deps, space, getStorage);
		if (!opened) return null;

		const adapter = app.vault.adapter;
		const { shared: sharedIgnore, local: localIgnore } = await getScope(
			space.root,
		);
		return {
			space,
			adapter,
			storage: opened.storage,
			index: createVaultIndex(app.vault),
			scope: createScopePolicy({
				settingsSync: settings.settingsSync,
				configDir: app.vault.configDir,
				sharedIgnore,
				localIgnore,
				symlinks: createSymlinkDetector(adapter, settings.ignoreSymlinks),
				root: space.root,
				otherRoots: nestedRoots(partition, space),
			}),
			key: opened.key,
			state: projectSession(state.state, opened.storage.identity(), space.root),
			maxFileBytes: settings.maxFileBytes,
			concurrency: opened.concurrency,
			history: settings.fileHistoryEnabled
				? { maxSnapshots: settings.fileHistoryMaxSnapshots }
				: undefined,
			live: deps.liveNotes?.(space),
			author: opened.author,
		};
	};
}

interface OpenedStorage {
	storage: StorageAdapter;
	key: EncryptionKey;
	concurrency: number;
	/** Unset in the vault, which publishes as the device. */
	author?: ManifestAuthor;
}

type AdapterCache = (
	spaceId: string,
	memo: string,
	create: (onConfigChanged: () => void) => StorageAdapter,
) => StorageAdapter;

/**
 * Adapters hold per-session caches (e.g. Drive folder ids), so they are memoised per space by full config;
 * any config change rebuilds.
 */
function createAdapterCache(deps: SessionFactoryDeps): AdapterCache {
	const cached = new Map<string, { memo: string; adapter: StorageAdapter }>();
	return (spaceId, memo, create) => {
		const hit = cached.get(spaceId);
		if (hit?.memo === memo) return hit.adapter;
		const adapter = create(() => {
			// The adapter rewrote its own config (refreshed token): rebuild against the saved values.
			cached.delete(spaceId);
			// Remote text is keyed by adapter instance, so the replaced one's entries are unreachable.
			clearRemoteTextCache();
			deps
				.persistSettings?.()
				.catch((err) => reportWarning("Could not save the settings.", err));
		});
		cached.set(spaceId, { memo, adapter });
		return adapter;
	};
}

async function openVault(
	deps: SessionFactoryDeps,
	getStorage: AdapterCache,
): Promise<OpenedStorage | null> {
	if (!isStorageConfigured(deps.settings)) {
		// A guest's vault is not synced by design: nothing to tell.
		if (isGuest(deps.settings)) return null;
		await deps.logs.warn(
			ESyncLogOperation.Session,
			"Session blocked because storage is not configured.",
		);
		deps.notify("Configure a storage backend first.");
		return null;
	}
	if (!(await deps.passphrase.prompt(false))) {
		await deps.logs.warn(
			ESyncLogOperation.Session,
			"Session blocked because the passphrase is missing.",
		);
		deps.notify("A passphrase is required.");
		return null;
	}
	const config = activeStorage(deps.settings);
	const storage = getStorage(
		VAULT_SPACE.id,
		JSON.stringify(config),
		(changed) => createStorageAdapter(config, changed),
	);
	const key = await resolveKeyWithRotationRetry(deps, storage);
	return key ? { storage, key, concurrency: config.concurrency } : null;
}

/** A share opens with the key in its record, never the vault passphrase. */
async function openShare(
	deps: SessionFactoryDeps,
	space: Space,
	getStorage: AdapterCache,
): Promise<OpenedStorage> {
	const record = deps.spaces.get(space.id);
	// Paused since the partition was taken: an operation queued before must not reach its storage.
	if (record && pauseOf(record, deps.settings) !== null) {
		throw new Error(`"${space.root}" is paused on this device.`);
	}
	const storage =
		record && shareStorage(record, activeStorage(deps.settings), space.root);
	// Thrown, not notified: the refresh shows it by the folder and goes on.
	if (!record || !storage) {
		throw new Error("Shared folders you own need S3 storage.");
	}
	const { person, name } = shareIdentity(record);
	return {
		storage: getStorage(space.id, storage.memo, storage.create),
		key: await shareKey(record),
		concurrency: storage.concurrency,
		author: { key: person, name },
	};
}

interface ScopeMatchers {
	shared: IgnoreMatcher;
	local: IgnoreMatcher;
}

/** Memoised per space root; the metadata cache's mtime and size invalidate it without reading the ignore note. */
function createScopeMatchers(
	deps: SessionFactoryDeps,
): (root: string) => Promise<ScopeMatchers> {
	const memos = new Map<
		string,
		ScopeMatchers & { stamp: string; patterns: string }
	>();
	return async (root) => {
		const file = deps.app.vault.getAbstractFileByPath(ignoreNoteOf(root));
		const patterns = deps.settings.ignorePatterns;
		// An absent note is never memoised: the index lags a just-created file, and a stale memo would sync
		// files its rules exclude.
		const stamp =
			file instanceof TFile ? `${file.stat.mtime}:${file.stat.size}` : null;
		const memo = memos.get(root);
		if (memo && memo.stamp === stamp && memo.patterns === patterns) return memo;
		const matchers: ScopeMatchers = {
			shared: await loadSharedIgnoreMatcher(deps.app.vault.adapter, root),
			local: createIgnoreMatcher(patterns),
		};
		if (stamp === null) memos.delete(root);
		else memos.set(root, { ...matchers, stamp, patterns });
		return matchers;
	};
}

/** Recovers from a passphrase rotated on another device: forget it, re-prompt once, retry; a second failure aborts. */
async function resolveKeyWithRotationRetry(
	deps: SessionFactoryDeps,
	storage: StorageAdapter,
): Promise<EncryptionKey | null> {
	const { passphrase, logs, notify } = deps;
	try {
		return await passphrase.resolveKey(storage);
	} catch (err) {
		if (!(err instanceof PassphraseRotatedError)) throw err;
		await logs.warn(
			ESyncLogOperation.Session,
			"Passphrase no longer matches the remote (rotated elsewhere); re-prompting.",
		);
		notify("Passphrase changed on another device. Enter the new one.");
		await passphrase.forget();
		if (!(await passphrase.prompt(true))) return null;
		try {
			return await passphrase.resolveKey(storage);
		} catch (retryErr) {
			if (!(retryErr instanceof PassphraseRotatedError)) throw retryErr;
			await logs.warn(
				ESyncLogOperation.Session,
				"Session blocked: passphrase still does not match after re-prompt.",
			);
			notify("Passphrase still incorrect.");
			return null;
		}
	}
}
