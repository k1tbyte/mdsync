import { type App, TFile } from "obsidian";
import type { EncryptionKey } from "@/core/crypto";
import type { LogService } from "@/core/logs";
import { ESyncLogOperation } from "@/core/logs";
import type { MdsyncSettings } from "@/core/settings";
import { reportWarning } from "@/core/shared";
import { createSymlinkDetector, createVaultIndex } from "@/core/vault";
import type { SpaceRecords } from "@/features/spaces";
import {
	pauseOf,
	shareIdentity,
	shareKey,
	shareStorage,
} from "@/features/spaces";
import {
	activeStorage,
	createStorageAdapter,
	isStorageConfigured,
	type StorageAdapter,
} from "@/features/storage";
import type {
	EngineDependencies,
	LiveNotes,
	LocalOpener,
	ManifestAuthor,
	PassphraseManager,
	SessionFiles,
	StatePersister,
	WriteJournal,
} from "@/features/sync";
import {
	clearRemoteTextCache,
	createIgnoreMatcher,
	createScopePolicy,
	type IgnoreMatcher,
	ignoreNoteOf,
	isGuest,
	loadSharedIgnoreMatcher,
	nestedRoots,
	PassphraseRotatedError,
	projectSession,
	type Space,
	VAULT_SPACE,
} from "@/features/sync";

export interface SessionFactoryDeps {
	app: App;
	settings: MdsyncSettings;
	spaces: Pick<SpaceRecords, "get">;
	passphrase: PassphraseManager;
	state: StatePersister;
	logs: LogService;
	notify: (message: string) => void;
	/** A sync asked for before this device has storage. */
	onNoStorage: () => void;
	/** Persists settings an adapter rewrote itself, such as a refreshed token. */
	persistSettings?: () => Promise<void>;
	/** Late-bound: live editing starts after the sync it hooks into. */
	liveNotes?: (space: Space) => LiveNotes | undefined;
	journal: WriteJournal;
}

export type SessionOpener = (
	space: Space,
	partition: readonly Space[],
) => Promise<EngineDependencies | null>;

/** One adapter and scope cache for both: a local look reuses the session's adapter. */
export function createSessionOpeners(deps: SessionFactoryDeps): {
	openSession: SessionOpener;
	openLocal: LocalOpener;
} {
	const getScope = createScopeMatchers(deps);
	const getStorage = createAdapterCache(deps);
	return {
		openSession: sessionOpener(deps, getScope, getStorage),
		openLocal: localOpener(deps, getScope, getStorage),
	};
}

type ScopeCache = (root: string) => Promise<ScopeMatchers>;

function sessionOpener(
	deps: SessionFactoryDeps,
	getScope: ScopeCache,
	getStorage: AdapterCache,
): SessionOpener {
	return async (space, partition) => {
		const { app, settings } = deps;
		const opened =
			space.root === ""
				? await openVault(deps, getStorage)
				: await openShare(deps, space, getStorage);
		if (!opened) return null;
		return {
			...(await sessionFiles(deps, getScope, space, partition, opened.storage)),
			storage: opened.storage,
			index: createVaultIndex(app.vault),
			key: opened.key,
			concurrency: opened.concurrency,
			history: settings.fileHistoryEnabled
				? { maxSnapshots: settings.fileHistoryMaxSnapshots }
				: undefined,
			live: deps.liveNotes?.(space),
			author: opened.author,
			journal: deps.journal,
		};
	};
}

/**
 * Never asks for the passphrase, resolves a key, logs, notifies or reaches the network: null where a
 * session would refuse or throw. The adapter serves only its identity.
 */
function localOpener(
	deps: SessionFactoryDeps,
	getScope: ScopeCache,
	getStorage: AdapterCache,
): LocalOpener {
	return async (space, partition) => {
		let storage: StorageAdapter | null;
		try {
			storage =
				space.root === ""
					? localVaultStorage(deps, getStorage)
					: localShareStorage(deps, space, getStorage);
		} catch {
			// An adapter its config cannot build: the session opener throws, this look just has nothing to show.
			return null;
		}
		if (!storage) return null;
		return {
			...(await sessionFiles(deps, getScope, space, partition, storage)),
			identity: storage.identity(),
		};
	};
}

async function sessionFiles(
	deps: SessionFactoryDeps,
	getScope: ScopeCache,
	space: Space,
	partition: readonly Space[],
	storage: StorageAdapter,
): Promise<SessionFiles> {
	const { app, settings, state } = deps;
	const adapter = app.vault.adapter;
	const { shared: sharedIgnore, local: localIgnore } = await getScope(
		space.root,
	);
	return {
		space,
		adapter,
		scope: createScopePolicy({
			settingsSync: settings.settingsSync,
			configDir: app.vault.configDir,
			sharedIgnore,
			localIgnore,
			symlinks: createSymlinkDetector(adapter, settings.ignoreSymlinks),
			root: space.root,
			otherRoots: nestedRoots(partition, space),
		}),
		state: projectSession(state.state, storage.identity(), space.root),
		maxFileBytes: settings.maxFileBytes,
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
		deps.onNoStorage();
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
	const storage = vaultStorage(deps, getStorage);
	const key = await resolveKeyWithRotationRetry(deps, storage);
	return key
		? { storage, key, concurrency: activeStorage(deps.settings).concurrency }
		: null;
}

function vaultStorage(
	deps: SessionFactoryDeps,
	getStorage: AdapterCache,
): StorageAdapter {
	const config = activeStorage(deps.settings);
	return getStorage(VAULT_SPACE.id, JSON.stringify(config), (changed) =>
		createStorageAdapter(config, changed),
	);
}

function localVaultStorage(
	deps: SessionFactoryDeps,
	getStorage: AdapterCache,
): StorageAdapter | null {
	return isStorageConfigured(deps.settings)
		? vaultStorage(deps, getStorage)
		: null;
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

function localShareStorage(
	deps: SessionFactoryDeps,
	space: Space,
	getStorage: AdapterCache,
): StorageAdapter | null {
	const record = deps.spaces.get(space.id);
	if (!record || pauseOf(record, deps.settings) !== null) return null;
	const storage = shareStorage(
		record,
		activeStorage(deps.settings),
		space.root,
	);
	return storage && getStorage(space.id, storage.memo, storage.create);
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
