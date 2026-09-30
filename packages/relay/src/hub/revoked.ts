/**
 * Grants the broker revoked lately: KV is eventually consistent, so the worker
 * may admit a revoked token for a minute more, which the hub (told at once)
 * refuses. A closed channel is refused for good, or devices still holding its
 * grant would refill its rows.
 */

import type { Grant } from "./peer";
import type { Sql } from "./store";

/** Well past KV's staleness (about a minute), so no stale read outlives it. */
const REVOKED_MS = 5 * 60_000;

export class RevokedGrants {
	constructor(private readonly sql: Sql) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS revoked(fingerprint TEXT PRIMARY KEY, until INTEGER NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS closed(channel TEXT PRIMARY KEY) WITHOUT ROWID",
		);
	}

	closeChannel(channel: string): void {
		this.sql.exec("INSERT OR IGNORE INTO closed(channel) VALUES(?)", channel);
	}

	add(fingerprint: string): void {
		const now = Date.now();
		this.sql.exec("DELETE FROM revoked WHERE until <= ?", now);
		this.sql.exec(
			"INSERT OR REPLACE INTO revoked(fingerprint, until) VALUES(?, ?)",
			fingerprint,
			now + REVOKED_MS,
		);
	}

	/** The admission with every revoked grant refused, as if the worker had seen it. */
	refuse(slots: readonly (Grant | null)[]): (Grant | null)[] {
		return slots.map((grant) =>
			grant && (this.has(grant.grant) || this.closed(grant.channel))
				? null
				: grant,
		);
	}

	private closed(channel: string): boolean {
		const [row] = this.sql
			.exec("SELECT 1 AS hit FROM closed WHERE channel = ?", channel)
			.toArray();
		return row !== undefined;
	}

	private has(fingerprint: string): boolean {
		const [row] = this.sql
			.exec(
				"SELECT 1 AS hit FROM revoked WHERE fingerprint = ? AND until > ?",
				fingerprint,
				Date.now(),
			)
			.toArray();
		return row !== undefined;
	}
}
