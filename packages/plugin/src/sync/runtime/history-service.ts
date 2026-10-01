import { DEFAULT_CONCURRENCY } from "@/constants";
import { sha256Hex } from "@/crypto";
import {
	bytesToText,
	isLikelyText,
	loadLocalBytes,
	textToBytes,
	writeRemoteObject,
} from "@/sync/content";
import type { EngineDependencies } from "@/sync/engine";
import { ownedFiles } from "@/sync/foreign";
import {
	type DeletedFilesResult,
	type FileVersion,
	loadVersionBytes,
	planVaultRestore,
	listDeletedFiles as queryDeletedFiles,
	getFileHistory as queryFileHistory,
	listSnapshots as querySnapshots,
	resolveSnapshotManifest,
	type SnapshotListResult,
	sameRestorePlan,
	setSnapshotPinned as storeSetSnapshotPinned,
	type VaultRestorePlan,
} from "@/sync/history";
import {
	applyHunks,
	complementSelection,
	computeHunks,
	type HunkSelection,
} from "@/sync/hunks";
import {
	buildHistoryDiff,
	type FileDiffModel,
	type HistoryDiffRequest,
} from "@/sync/projection";
import type { LocalSnapshot, Manifest } from "@/sync/types";
import { runWithConcurrency, withEolOf } from "@/utils";
import { trashPath, writeBinary } from "@/vault/io";
import { scanVault } from "@/vault/scanner";

const NO_SESSION = "Storage session unavailable";

interface HistoryServiceDeps {
	/** The session of the space that owns the path; the vault's without one. */
	openSession: (path?: string) => Promise<EngineDependencies | null>;
	/** Serialises writes against the rest of the sync queue. */
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
	refresh: () => Promise<void>;
}

/** Reads and restores past file versions from the snapshot history. */
export class HistoryService {
	constructor(private readonly deps: HistoryServiceDeps) {}

	async getFileHistory(path: string): Promise<FileVersion[]> {
		const session = await this.deps.openSession(path);
		if (!session) return [];
		return queryFileHistory({
			storage: session.storage,
			key: session.key,
			root: session.space.root,
			path,
		});
	}

	async listDeletedFiles(): Promise<DeletedFilesResult> {
		const session = await this.deps.openSession();
		if (!session) return { files: [], lagging: false, truncated: false };
		const deleted = await queryDeletedFiles({
			storage: session.storage,
			key: session.key,
			root: session.space.root,
		});
		return {
			...deleted,
			files: deleted.files.filter(({ path }) => session.scope.includes(path)),
		};
	}

	async listSnapshots(): Promise<SnapshotListResult> {
		const session = await this.deps.openSession();
		if (!session) return { snapshots: [], lagging: false };
		return querySnapshots({
			storage: session.storage,
			key: session.key,
			root: session.space.root,
		});
	}

	/** What a restore would change, computed against a fresh scan of the vault. */
	async previewVaultRestore(snapshotId: string): Promise<VaultRestorePlan> {
		const session = await this.requireSession();
		return this.planRestore(
			session,
			await this.requireSnapshot(session, snapshotId),
		);
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
			const plan = await this.planRestore(session, target);
			if (!sameRestorePlan(plan, confirmed)) return { plan, applied: false };
			await runWithConcurrency(
				plan.write,
				session.concurrency ?? DEFAULT_CONCURRENCY,
				async (item) => {
					await writeRemoteObject(session, item.path, item.entry.hash);
				},
			);
			await runWithConcurrency(
				plan.remove,
				session.concurrency ?? DEFAULT_CONCURRENCY,
				async (path) => {
					await trashPath(session.adapter, path);
				},
			);
			await this.deps.refresh();
			return { plan, applied: true };
		});
	}

	private async planRestore(
		session: EngineDependencies,
		target: Manifest,
	): Promise<VaultRestorePlan> {
		return planVaultRestore(target, await scanLocal(session), (path) =>
			session.scope.includes(path),
		);
	}

	private async requireSnapshot(
		session: EngineDependencies,
		snapshotId: string,
	): Promise<Manifest> {
		const target = await resolveSnapshotManifest(
			session.storage,
			session.key,
			session.space.root,
			snapshotId,
		);
		if (!target) {
			throw new Error(
				"That snapshot can no longer be rebuilt from history, so the vault cannot be restored to it.",
			);
		}
		return { ...target, files: ownedFiles(target.files, session.scope) };
	}

	/** Queued: it rewrites the history log a push or GC of this device also rewrites. */
	setSnapshotPinned(
		snapshotId: string,
		pinned: boolean,
		label?: string,
	): Promise<void> {
		return this.deps.enqueue(async () => {
			const session = await this.requireSession();
			await storeSetSnapshotPinned(
				session.storage,
				session.key,
				session.space.root,
				snapshotId,
				pinned,
				label,
			);
		});
	}

	async getHistoryDiff(
		request: HistoryDiffRequest,
	): Promise<FileDiffModel | null> {
		const session = await this.deps.openSession(request.path);
		if (!session) return null;
		return buildHistoryDiff(session, request);
	}

	async restoreFileVersion(path: string, hash: string): Promise<void> {
		await this.deps.enqueue(async () => {
			const session = await this.requireSession(path);
			const bytes = await loadVersionBytes(session.storage, session.key, hash);
			await writeBinary(session.adapter, path, bytes);
			await this.deps.refresh();
		});
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
			await writeBinary(session.adapter, path, textToBytes(merged));
			await this.deps.refresh();
		});
	}

	private async requireSession(path?: string): Promise<EngineDependencies> {
		const session = await this.deps.openSession(path);
		if (!session) throw new Error(NO_SESSION);
		return session;
	}
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
