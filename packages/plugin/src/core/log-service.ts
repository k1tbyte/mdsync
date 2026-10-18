import type { DataAdapter } from "obsidian";

import {
	appendSyncLog,
	createSyncLogEntry,
	ESyncLogLevel,
	ESyncLogOperation,
	loadSyncLogs,
	type SyncLogEntry,
	saveSyncLogs,
} from "@/logs/store";
import { setDiagnosticsSink } from "@/shared";

/** A push logs many lines in a burst: one file write after they settle. */
const WRITE_QUIET_MS = 1000;

export class LogService {
	private entries: SyncLogEntry[] = [];
	/** Append and clear share one file; serialising stops the older snapshot landing last. */
	private writes: Promise<void> = Promise.resolve();
	private timer: number | null = null;
	/** Unloaded: a line from an operation still winding down is written at once, no timer outlives us. */
	private disposed = false;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
	) {}

	async load(): Promise<void> {
		this.entries = await loadSyncLogs(this.adapter, this.configDir);
		setDiagnosticsSink((message, details) => {
			void this.warn(ESyncLogOperation.Session, message, details ?? []);
		});
	}

	dispose(): void {
		this.disposed = true;
		setDiagnosticsSink(null);
		if (this.timer !== null) void this.save();
	}

	getEntries(): readonly SyncLogEntry[] {
		return this.entries;
	}

	async clear(): Promise<void> {
		this.entries = [];
		await this.save();
	}

	info(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Info, operation, message, details);
	}

	warn(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Warn, operation, message, details);
	}

	error(
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[] = [],
	): Promise<void> {
		return this.append(ESyncLogLevel.Error, operation, message, details);
	}

	private append(
		level: ESyncLogLevel,
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[],
	): Promise<void> {
		this.entries = appendSyncLog(
			this.entries,
			createSyncLogEntry(level, operation, message, details),
		);
		if (this.disposed) return this.save();
		this.timer ??= window.setTimeout(() => void this.save(), WRITE_QUIET_MS);
		return Promise.resolve();
	}

	/** A failed log write goes to the console and is swallowed: callers await it mid push and pull. */
	private save(): Promise<void> {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		const entries = this.entries;
		const write = async (): Promise<void> => {
			try {
				await saveSyncLogs(this.adapter, this.configDir, entries);
			} catch (err) {
				console.warn("[mdsync] could not write the diagnostics log", err);
			}
		};
		this.writes = this.writes.then(write);
		return this.writes;
	}
}
