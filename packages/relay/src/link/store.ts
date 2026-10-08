/**
 * One share link's state in its Durable Object's SQLite: the sealed blob in chunks, the view counter, the
 * gate. Every method is synchronous, so a view is counted and a spent link erased in one turn, and two
 * opens never both take the last view.
 */

import {
	LINK_MAX_SEALED_BYTES,
	type LinkMeta,
	type LinkStatus,
} from "@mdsync/protocol";

import type { Sql, SqlValue } from "../hub/store";

/** SQLite caps a value at 2 MB. */
const CHUNK_BYTES = 1024 * 1024;
const FAILS_BEFORE_COOLDOWN = 5;
const COOLDOWN_START_S = 60;
const COOLDOWN_MAX_S = 60 * 60;
/** Clients remembered per link; the least recently seen go first. */
const THROTTLED_CLIENTS_MAX = 128;

export interface LinkSettings {
	maxViews: number | null;
	/** Unix seconds. */
	expires: number | null;
	/** Hash of the gate; null when the link has no passphrase. */
	gate: string | null;
	salt: string | null;
}

export type OpenResult =
	| {
			ok: true;
			blob: ArrayBuffer;
			viewsLeft: number | null;
			expires: number | null;
	  }
	| { ok: false; reason: "gone" }
	| { ok: false; reason: "gate"; retryAfter: number | null }
	| { ok: false; reason: "cooldown"; retryAfter: number };

/** A creation never inherits a counter; only an update, which needs a link still standing, keeps one. */
export type PutMode = "create" | "update";
export type PutResult = "stored" | "exists" | "gone";

interface Row extends LinkSettings {
	views: number;
	size: number;
}

interface Throttle {
	fails: number;
	lockedUntil: number;
}

export class LinkStore {
	constructor(
		private readonly sql: Sql,
		private readonly now: () => number = Date.now,
		/** Runs once a link is erased, to hand its storage back. */
		private readonly onEnd: () => void = () => undefined,
	) {}

	put(blob: ArrayBuffer, settings: LinkSettings, mode: PutMode): PutResult {
		if (blob.byteLength === 0 || blob.byteLength > LINK_MAX_SEALED_BYTES) {
			throw new RangeError("Link blob has an unsupported size");
		}
		// Not `live()` on a creation: erasing an old link here would hand the storage back under the new one.
		const old = this.row();
		const standing = old !== null && this.stands(old);
		if (mode === "create" && standing) return "exists";
		if (mode === "update" && !standing) {
			this.live();
			return "gone";
		}
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS link(id INTEGER PRIMARY KEY CHECK(id = 1), views INTEGER NOT NULL, max_views INTEGER, expires INTEGER, gate TEXT, salt TEXT, size INTEGER NOT NULL)",
		);
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS chunks(seq INTEGER PRIMARY KEY, data BLOB NOT NULL)",
		);
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS throttle(client TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, seen INTEGER NOT NULL) WITHOUT ROWID",
		);
		this.sql.exec("DELETE FROM chunks");
		this.sql.exec("DELETE FROM throttle");
		for (let at = 0, seq = 0; at < blob.byteLength; at += CHUNK_BYTES) {
			this.sql.exec(
				"INSERT INTO chunks(seq, data) VALUES(?, ?)",
				seq++,
				blob.slice(at, at + CHUNK_BYTES),
			);
		}
		this.sql.exec(
			"INSERT OR REPLACE INTO link(id, views, max_views, expires, gate, salt, size) VALUES(1, ?, ?, ?, ?, ?, ?)",
			standing && old ? old.views : 0,
			settings.maxViews,
			settings.expires,
			settings.gate,
			settings.salt,
			blob.byteLength,
		);
		return "stored";
	}

	/**
	 * Counts a view and hands the blob out; the last permitted view erases the link as it leaves. Wrong
	 * gates slow down the client that sent them, never the link: anyone holding only the id could lock the
	 * readers out otherwise.
	 */
	open(gate: string | null, client: string): OpenResult {
		const link = this.live();
		if (!link) return GONE;
		const now = this.now();
		const throttle = this.throttleOf(client);
		if (throttle.lockedUntil > now) {
			return {
				ok: false,
				reason: "cooldown",
				retryAfter: Math.ceil((throttle.lockedUntil - now) / 1000),
			};
		}
		if (link.gate !== null && !(gate !== null && sameHash(link.gate, gate))) {
			return this.refuse(client, throttle, now);
		}
		const blob = this.read(link.size);
		const views = link.views + 1;
		const viewsLeft = link.maxViews === null ? null : link.maxViews - views;
		if (viewsLeft !== null && viewsLeft <= 0) {
			this.erase();
			return { ok: true, blob, viewsLeft, expires: link.expires };
		}
		this.sql.exec("UPDATE link SET views = ? WHERE id = 1", views);
		if (throttle.fails > 0) {
			this.sql.exec("DELETE FROM throttle WHERE client = ?", client);
		}
		return { ok: true, blob, viewsLeft, expires: link.expires };
	}

	status(): LinkStatus | null {
		const link = this.live();
		return (
			link && {
				views: link.views,
				maxViews: link.maxViews,
				expires: link.expires,
				protected: link.gate !== null,
				size: link.size,
			}
		);
	}

	meta(): LinkMeta | null {
		const link = this.live();
		return link && { protected: link.gate !== null, salt: link.salt };
	}

	/** Ends the link now, whatever its state. */
	revoke(): void {
		if (this.row()) this.erase();
	}

	/** The row of a link that still stands; one expired or spent is erased on the way. */
	private live(): Row | null {
		const link = this.row();
		if (!link) return null;
		if (this.stands(link)) return link;
		this.erase();
		return null;
	}

	private stands(link: Row): boolean {
		const expired = link.expires !== null && link.expires * 1000 <= this.now();
		const spent = link.maxViews !== null && link.views >= link.maxViews;
		return !expired && !spent;
	}

	private refuse(client: string, before: Throttle, now: number): OpenResult {
		const fails = before.fails + 1;
		const wait =
			fails < FAILS_BEFORE_COOLDOWN
				? null
				: Math.min(
						COOLDOWN_START_S * 2 ** (fails - FAILS_BEFORE_COOLDOWN),
						COOLDOWN_MAX_S,
					);
		this.sql.exec(
			"INSERT OR REPLACE INTO throttle(client, fails, locked_until, seen) VALUES(?, ?, ?, ?)",
			client,
			fails,
			wait === null ? 0 : now + wait * 1000,
			now,
		);
		// A client still in cooldown ranks by when it ends, or others' later failures would evict its lock.
		this.sql.exec(
			"DELETE FROM throttle WHERE client IN (SELECT client FROM throttle ORDER BY max(seen, locked_until) DESC LIMIT -1 OFFSET ?)",
			THROTTLED_CLIENTS_MAX,
		);
		return { ok: false, reason: "gate", retryAfter: wait };
	}

	private throttleOf(client: string): Throttle {
		const [row] = this.sql
			.exec("SELECT fails, locked_until FROM throttle WHERE client = ?", client)
			.toArray();
		return {
			fails: Number(row?.fails ?? 0),
			lockedUntil: Number(row?.locked_until ?? 0),
		};
	}

	private row(): Row | null {
		if (!this.hasTable()) return null;
		const [row] = this.sql.exec("SELECT * FROM link WHERE id = 1").toArray();
		if (!row) return null;
		return {
			views: Number(row.views),
			maxViews: nullable(row.max_views),
			expires: nullable(row.expires),
			gate: typeof row.gate === "string" ? row.gate : null,
			salt: typeof row.salt === "string" ? row.salt : null,
			size: Number(row.size),
		};
	}

	private read(size: number): ArrayBuffer {
		const out = new Uint8Array(size);
		let at = 0;
		for (const { data } of this.sql
			.exec("SELECT data FROM chunks ORDER BY seq")
			.toArray()) {
			const chunk = new Uint8Array(data as ArrayBuffer);
			out.set(chunk, at);
			at += chunk.length;
		}
		return out.buffer;
	}

	/** An id nobody created has no tables, and asking about it must not make any. */
	private hasTable(): boolean {
		return (
			this.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'link'").toArray()
				.length > 0
		);
	}

	private erase(): void {
		this.sql.exec("DELETE FROM chunks");
		this.sql.exec("DELETE FROM throttle");
		this.sql.exec("DELETE FROM link");
		this.onEnd();
	}
}

const GONE: OpenResult = { ok: false, reason: "gone" };

function nullable(value: SqlValue | undefined): number | null {
	return value === null || value === undefined ? null : Number(value);
}

/** Equal-length hex digests, compared without stopping at the first difference. */
function sameHash(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}
