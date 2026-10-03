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

export class LogService {
	private entries: SyncLogEntry[] = [];
	/** Append and clear share one file; serialising stops the older snapshot landing last. */
	private writes: Promise<void> = Promise.resolve();

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
		setDiagnosticsSink(null);
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

	private async append(
		level: ESyncLogLevel,
		operation: ESyncLogOperation,
		message: string,
		details: readonly string[],
	): Promise<void> {
		this.entries = appendSyncLog(
			this.entries,
			createSyncLogEntry(level, operation, message, details),
		);
		await this.save();
	}

	/** A failed log write goes to the console and is swallowed: callers await it mid push and pull. */
	private save(): Promise<void> {
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
