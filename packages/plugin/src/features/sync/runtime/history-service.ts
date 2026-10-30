import { DEFAULT_CONCURRENCY } from "@/core/constants";
import { sha256Hex } from "@/core/crypto";
import { runWithConcurrency, withEolOf } from "@/core/utils";
import { trashPath, unchangedSince } from "@/core/vault";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
	writeLocalFile,
	writeRemoteObject,
} from "../changes/content";
import { runWithFileConcurrency } from "../changes/file-concurrency";
import { entryAt } from "../changes/records";
import { skipUnholdableNames } from "../changes/remote-names";
import type { EngineDependencies } from "../engine";
import { historyTracks, untrackedDir } from "../history/changes";
import type { Activity } from "../history/model/types";
import {
	type HistoryQuery,
	loadVersionBytes,
	listDeletedFiles as queryDeletedFiles,
	getFileHistory as queryFileHistory,
	listSnapshots as querySnapshots,
	resolveSnapshotManifest,
	setSnapshotPinned as storeSetSnapshotPinned,
} from "../history/query";
import {
	planVaultRestore,
	sameRestorePlan,
	type VaultRestorePlan,
} from "../history/restore-vault";
import type {
	DeletedFilesResult,
	FileVersion,
	SnapshotListResult,
} from "../history/types";
import {
	applyHunks,
	complementSelection,
	computeHunks,
	type HunkSelection,
} from "../hunks/hunks";
import {
	buildHistoryDiff,
	type FileDiffModel,
	type HistoryDiffRequest,
} from "../hunks/projection";
import { coldSince } from "../live-notes";
import { ownedFiles } from "../remote/foreign";
import type { Space } from "../remote/space";
import { scanVault } from "../scope/scanner";
import type { LocalSnapshot, Manifest } from "../types";

const NO_SESSION = "Storage session unavailable";

interface HistoryServiceDeps {
	/** The session of the space that owns the path; the vault's without one. */
	openSession: (path?: string) => Promise<EngineDependencies | null>;
	/** Serialises writes against the rest of the sync queue. */
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
	refresh: () => Promise<void>;
	/** Keeps the vault's activity for the settings overview. */
	remember: (storage: string, activity: Activity, since: number) => void;
	/** What a restore left in a space (null: removed), kept out of automatic pushes; before its refresh. */
	restored: (space: Space, left: ReadonlyMap<string, string | null>) => void;
}

/** Reads and restores past file versions from the snapshot history. */
export class HistoryService {
	constructor(private readonly deps: HistoryServiceDeps) {}

	async getFileHistory(path: string): Promise<FileVersion[]> {
		const session = await this.deps.openSession(path);
		if (!session) return [];
		return queryFileHistory({ ...queryOf(session), path });
	}

	async listDeletedFiles(): Promise<DeletedFilesResult> {
		const session = await this.deps.openSession();
		if (!session) return { files: [], lagging: false, truncated: false };
		const deleted = await queryDeletedFiles(queryOf(session));
		return {
			...deleted,
			files: deleted.files.filter(({ path }) => session.scope.includes(path)),
		};
	}

	async listSnapshots(): Promise<SnapshotListResult> {
		const session = await this.deps.openSession();
		if (!session)
			return { snapshots: [], lagging: false, truncated: false, activity: {} };
		const since = Date.now();
		const result = await querySnapshots(queryOf(session));
		this.deps.remember(session.storage.identity(), result.activity, since);
		return result;
	}

	/** What a restore would change, computed against a fresh scan of the vault. */
	async previewVaultRestore(snapshotId: string): Promise<VaultRestorePlan> {
		const session = await this.requireSession();
		const target = await this.requireSnapshot(session, snapshotId);
		return planRestore(session, target, await scanLocal(session));
	}

	/**
	 * Makes the vault match a past snapshot, local only; removed files go to the trash. Applies nothing and
	 * returns the fresh plan if the vault moved since `confirmed`.
	 */
	async restoreVault(
		snapshotId: string,
		confirmed: VaultRestorePlan,
	): Promise<{ plan: VaultRestorePlan; applied: boolean }> {
		return this.deps.enqueue(async () => {
			const session = await this.requireSession();
			const target = await this.requireSnapshot(session, snapshotId);
			const local = await scanLocal(session);
			const plan = planRestore(session, target, local);
			if (!sameRestorePlan(plan, confirmed)) return { plan, applied: false };
			// An edit saved while the restore downloads keeps its file, as in a pull.
			const seen = (path: string) => entryAt(local.files, path);
			// On a case-blind disk a recased file answers for the target's spelling.
			const spelled = new Map(
				Object.keys(local.files).map((path) => [path.toLowerCase(), path]),
			);
			const recased = (path: string) => spelled.get(path.toLowerCase());
			const ready = (path: string) => {
				const exact = coldSince(session, path, seen(path));
				const alias = recased(path);
				const other = alias && coldSince(session, path, seen(alias));
				return async () => (await exact()) || (!!other && (await other()));
			};
			// Held before the first write: a restore cut short must not reach an automatic push either.
			this.deps.restored(
				session.space,
				new Map(
					plan.write.flatMap(({ path, entry: { hash } }) => [
						[path, hash],
						[recased(path) ?? path, hash],
					]),
				),
			);
			const claims = await session.journal?.claim(
				session.space,
				new Map(
					plan.write.map(({ path, entry: { hash } }) => [path, { hash }]),
				),
			);
			try {
				await runWithFileConcurrency(
					plan.write,
					session.concurrency ?? DEFAULT_CONCURRENCY,
					(item) => item.entry.size,
					async ({ path, entry }) => {
						await writeRemoteObject(session, path, entry.hash, {
							claims,
							ready: ready(path),
						});
					},
				);
			} finally {
				if (claims) await session.journal?.settle(claims);
			}
			this.deps.restored(
				session.space,
				new Map(plan.remove.map((path) => [path, null])),
			);
			await runWithConcurrency(
				plan.remove,
				session.concurrency ?? DEFAULT_CONCURRENCY,
				async (path) => {
					if (await unchangedSince(session.adapter, path, seen(path))) {
						await trashPath(session.adapter, path);
					}
				},
			);
			await this.deps.refresh();
			return { plan, applied: true };
		});
	}

	private async requireSnapshot(
		session: EngineDependencies,
		snapshotId: string,
	): Promise<Manifest> {
		const target = await resolveSnapshotManifest(queryOf(session), snapshotId);
		if (!target) {
			throw new Error(
				"That snapshot can no longer be rebuilt from history, so the vault cannot be restored to it.",
			);
		}
		return { ...target, files: ownedFiles(target.files, session.scope) };
	}

	/**
	 * Queued with pushes: the pin is replayed from the history they write. `path` names a file of the space
	 * whose snapshot it is (a shared folder's History); the vault's without one.
	 */
	setSnapshotPinned(
		snapshotId: string,
		pinned: boolean,
		label?: string,
		path?: string,
	): Promise<void> {
		return this.deps.enqueue(async () => {
			const session = await this.requireSession(path);
			await storeSetSnapshotPinned(queryOf(session), snapshotId, pinned, label);
		});
	}

	/** The version is read in the space of `source`: the vault adapter serves the current side of any path. */
	async getHistoryDiff(
		request: HistoryDiffRequest,
	): Promise<FileDiffModel | null> {
		const session = await this.deps.openSession(request.source ?? request.path);
		if (!session) return null;
		return buildHistoryDiff(session, request);
	}

	/** `from` is the path the version was stored under, when it lands at another (a restore-to). */
	async restoreFileVersion(
		path: string,
		hash: string,
		from = path,
	): Promise<void> {
		await this.deps.enqueue(async () => {
			await this.writeVersion(path, hash, from);
			await this.deps.refresh();
		});
	}

	/**
	 * Many files in one queue turn and one refresh: each refresh is a full vault scan and remote compare.
	 * Returns the paths that failed; only the closing refresh rejects.
	 */
	async restoreFileVersions(
		items: { path: string; hash: string }[],
	): Promise<string[]> {
		if (items.length === 0) return [];
		return this.deps.enqueue(async () => {
			const failed: string[] = [];
			for (const { path, hash } of items) {
				await this.writeVersion(path, hash).catch(() => failed.push(path));
			}
			if (failed.length < items.length) await this.deps.refresh();
			return failed;
		});
	}

	/** Read in the space that stored it, written in the one that owns `path`: a batch may span spaces. */
	private async writeVersion(
		path: string,
		hash: string,
		from = path,
	): Promise<void> {
		const source = await this.requireSession(from);
		const bytes = await loadVersionBytes(source.storage, source.key, hash);
		const target = from === path ? source : await this.requireSession(path);
		this.deps.restored(target.space, new Map([[path, hash]]));
		await writeLocalFile(target, path, bytes);
	}

	async restoreHistoryHunks(
		path: string,
		hash: string,
		selected: HunkSelection,
		/** sha256 of the working copy the hunks were drawn against. */
		expectedCurrentHash?: string,
	): Promise<void> {
		if (selected.size === 0) return;
		await this.deps.enqueue(async () => {
			const session = await this.requireSession(path);
			const versionBytes = await loadVersionBytes(
				session.storage,
				session.key,
				hash,
			);
			const currentBytes = await loadLocalBytes(session.adapter, path);
			if (
				!isLikelyText(versionBytes) ||
				!currentBytes ||
				!isLikelyText(currentBytes)
			) {
				throw new Error("Per-hunk restore is only supported for text files");
			}
			const currentText = bytesToText(currentBytes);
			if (
				expectedCurrentHash &&
				(await sha256Hex(textToBytes(currentText))) !== expectedCurrentHash
			) {
				throw new Error(
					"This file changed since the diff was drawn, so the hunk numbers no longer line up. Reopen the diff and try again.",
				);
			}
			// Same argument order as the projection: the view numbers hunks version-to-current.
			const versionText = bytesToText(versionBytes);
			const { hunks } = computeHunks(versionText, currentText);
			// `applyHunks` takes the right side of selected segments, so keeping the version's side means
			// selecting all the others.
			const merged = withEolOf(
				currentText,
				applyHunks(versionText, hunks, complementSelection(hunks, selected)),
			);
			const bytes = textToBytes(merged);
			this.deps.restored(
				session.space,
				new Map([[path, await sha256Hex(bytes)]]),
			);
			await writeLocalFile(session, path, bytes);
			await this.deps.refresh();
		});
	}

	private async requireSession(path?: string): Promise<EngineDependencies> {
		const session = await this.deps.openSession(path);
		if (!session) throw new Error(NO_SESSION);
		return session;
	}
}

function queryOf(session: EngineDependencies): HistoryQuery {
	return {
		storage: session.storage,
		key: session.key,
		root: session.space.root,
		horizon: session.history?.horizon ?? null,
		configDir: untrackedDir(session),
	};
}

/** A name this disk cannot hold (reserved, or one spelling of a case clash) is skipped, as a pull skips it. */
function planRestore(
	session: EngineDependencies,
	target: Manifest,
	local: LocalSnapshot,
): VaultRestorePlan {
	return planVaultRestore(
		target,
		skipUnholdableNames(local, target, session.state.baseline, session.scope),
		(path) => session.scope.includes(path),
		historyTracks(untrackedDir(session)),
	);
}

/** The local half of a compare: a restore plan needs only the disk, not the remote manifest download. */
async function scanLocal(session: EngineDependencies): Promise<LocalSnapshot> {
	const { snapshot } = await scanVault(
		session.adapter,
		session.scope,
		{
			maxFileBytes: session.maxFileBytes,
			concurrency: session.concurrency,
			index: session.index,
			expected: session.state.baseline?.files,
		},
		session.state.hashCache,
	);
	return snapshot;
}
