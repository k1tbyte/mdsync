import { ESyncLogOperation } from "@/core/logs";
import { errorMessage } from "@/core/shared";
import { LOG_PATH_LIMIT } from "../constants";
import type { EngineDependencies } from "../engine";
import { collectHistoryGarbage } from "../history/gc";
import { clearLegacyHistory } from "../history/legacy";
import { type Space, VAULT_SPACE } from "../remote/space";
import {
	type CleanResult,
	cleanSummary,
	deepCleanOrphans,
	type VerifyResult,
	verifyRemote,
} from "./maintenance";

/** A run with nothing due still lists `history/`: one per space this often is plenty. */
const HISTORY_GC_EVERY_MS = 10 * 60_000;

type Log = (
	operation: ESyncLogOperation,
	message: string,
	details?: readonly string[],
) => Promise<void>;

interface MaintenanceServiceDeps {
	openSession: (space: Space) => Promise<EngineDependencies | null>;
	/** Between operations: a push of this device uploads blobs its manifest does not name yet. */
	enqueue: <T>(task: () => Promise<T>) => Promise<T>;
	/** As `enqueue`, without showing the plugin busy. */
	enqueueQuiet: <T>(task: () => Promise<T>) => Promise<T>;
	logInfo: Log;
	logWarn: Log;
}

export class MaintenanceService {
	private readonly lastGc = new Map<string, number>();
	private readonly legacyCleared = new Set<string>();
	private disposed = false;

	constructor(private readonly deps: MaintenanceServiceDeps) {}

	/** Clears 1.x history and thins history after a published push; never awaited by it, and a failure only logs. */
	afterPush(space: Space): void {
		const now = Date.now();
		if (now - (this.lastGc.get(space.id) ?? 0) < HISTORY_GC_EVERY_MS) return;
		this.lastGc.set(space.id, now);
		void this.deps
			.enqueueQuiet(async () => {
				if (this.disposed) return;
				const session = await this.deps.openSession(space);
				if (!session) return;
				// Once a session, history on or off: a 1.x pin blocks every sweep.
				if (!this.legacyCleared.has(space.id)) {
					const removed = await clearLegacyHistory(
						session.storage,
						session.key,
					);
					this.legacyCleared.add(space.id);
					if (removed > 0) {
						await this.deps.logInfo(
							ESyncLogOperation.Push,
							`Old-format file history removed (${removed} object(s)).`,
						);
					}
				}
				if (!session.history) return;
				const { written, retired, swept } = await collectHistoryGarbage(
					session.storage,
					session.key,
					session.space.root,
					session.history,
				);
				if (written + retired + swept > 0) {
					await this.deps.logInfo(
						ESyncLogOperation.Push,
						`History cleanup: ${written} object(s) written, ${retired} retired, ${swept} file version(s) removed.`,
					);
				}
			})
			.catch((err) =>
				this.deps.logWarn(
					ESyncLogOperation.Push,
					`History cleanup failed: ${errorMessage(err)}`,
				),
			);
	}

	dispose(): void {
		this.disposed = true;
	}

	async verifyRemote(deep: boolean): Promise<VerifyResult | null> {
		const session = await this.deps.openSession(VAULT_SPACE);
		if (!session) return null;
		const result = await verifyRemote(
			session.storage,
			session.key,
			session.space.root,
			deep,
		);
		await this.deps.logInfo(
			ESyncLogOperation.Compare,
			`Integrity check: ${result.checked} object(s), ${result.missing.length} missing, ${result.corrupt.length} corrupt.`,
			[...result.missing, ...result.corrupt].slice(0, LOG_PATH_LIMIT),
		);
		return result;
	}

	deepCleanRemote(): Promise<CleanResult | null> {
		return this.deps.enqueue(async () => {
			const session = await this.deps.openSession(VAULT_SPACE);
			if (!session) return null;
			const result = await deepCleanOrphans(
				session.storage,
				session.key,
				session.space.root,
			);
			await this.deps.logInfo(
				ESyncLogOperation.Reset,
				`Deep-clean ${cleanSummary(result)}`,
			);
			return result;
		});
	}
}
