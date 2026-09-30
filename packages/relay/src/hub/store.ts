/**
 * The hub's document logs in the Durable Object's SQLite: one row per delta and
 * one per document (snapshot, forwarding pointer, log name). All of it
 * ciphertext. An update writes its delta row only: the head is the last delta's
 * seq, so the document row changes on compaction and rotation alone.
 */

import type { DocState, DocStore, Pointer } from "./docs";

/** `SqlStorageValue`, spelled out so code without workers-types can import this. */
export type SqlValue = ArrayBuffer | string | number | null;

/** The slice of `SqlStorage` used here, so tests can back it with node:sqlite. */
export interface Sql {
	exec(
		query: string,
		...bindings: SqlValue[]
	): { toArray(): Record<string, SqlValue>[] };
}

interface DocRow {
	head: number;
	snapSeq: number;
	moved: string | null;
	log: string;
}

/** A fresh log id, drawn per row. */
const NEW_LOG = "lower(hex(randomblob(8)))";

/** `movedTo` is asked on every frame and a pointer never changes once set, so answers are kept, oldest out first. */
export const MOVED_CACHE_MAX = 1024;

const cacheKey = (channel: string, doc: string) =>
	`${channel.length}:${channel}${doc}`;

export class SqlDocStore implements DocStore {
	private readonly moved = new Map<string, Pointer | null>();

	constructor(private readonly sql: Sql) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS docs(channel TEXT, doc TEXT, snap_seq INTEGER NOT NULL DEFAULT 0, moved TEXT, moved_note BLOB, snap BLOB, log TEXT, PRIMARY KEY(channel, doc)) WITHOUT ROWID",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS deltas(channel TEXT, doc TEXT, seq INTEGER, blob BLOB NOT NULL, PRIMARY KEY(channel, doc, seq)) WITHOUT ROWID",
		);
	}

	movedTo(channel: string, doc: string): Pointer | null {
		const key = cacheKey(channel, doc);
		const known = this.moved.get(key);
		if (known !== undefined) return known;
		const [row] = this.sql
			.exec(
				"SELECT moved, moved_note FROM docs WHERE channel = ? AND doc = ?",
				channel,
				doc,
			)
			.toArray();
		const pointer =
			typeof row?.moved === "string"
				? {
						target: row.moved,
						note: bytes(row.moved_note ?? new ArrayBuffer(0)),
					}
				: null;
		this.remember(key, pointer);
		return pointer;
	}

	private remember(key: string, pointer: Pointer | null): void {
		if (this.moved.size >= MOVED_CACHE_MAX && !this.moved.has(key)) {
			this.moved.delete(this.moved.keys().next().value as string);
		}
		this.moved.set(key, pointer);
	}

	purge(channel: string): void {
		this.sql.exec("DELETE FROM deltas WHERE channel = ?", channel);
		this.sql.exec("DELETE FROM docs WHERE channel = ?", channel);
		this.moved.clear();
	}

	rotate(
		channel: string,
		doc: string,
		pointer: Pointer,
		upto: number,
		payload: Uint8Array,
	): boolean {
		const row = this.row(channel, doc);
		// No row is an empty log: a room that lost its log moves on from there.
		if ((row?.moved ?? null) !== null || (row?.head ?? 0) !== upto) {
			return false;
		}
		if (this.seed(channel, pointer.target, payload) === null) return false;
		this.markMoved(channel, doc, pointer);
		return true;
	}

	/** Drops the log: from here the pointer is the only answer. */
	private markMoved(channel: string, doc: string, pointer: Pointer): void {
		this.sql.exec(
			"INSERT INTO docs(channel, doc, moved, moved_note) VALUES(?, ?, ?, ?) ON CONFLICT(channel, doc) DO UPDATE SET snap_seq = 0, snap = NULL, moved = excluded.moved, moved_note = excluded.moved_note",
			channel,
			doc,
			pointer.target,
			blob(pointer.note),
		);
		this.sql.exec(
			"DELETE FROM deltas WHERE channel = ? AND doc = ?",
			channel,
			doc,
		);
		this.remember(cacheKey(channel, doc), pointer);
	}

	append(channel: string, doc: string, payload: Uint8Array): number {
		return this.log(channel, doc, payload, false) as number;
	}

	seed(channel: string, doc: string, payload: Uint8Array): number | null {
		return this.log(channel, doc, payload, true);
	}

	private log(
		channel: string,
		doc: string,
		payload: Uint8Array,
		seedOnly: boolean,
	): number | null {
		const row = this.row(channel, doc);
		if (row && seedOnly) return null;
		if (!row) {
			this.sql.exec(
				`INSERT INTO docs(channel, doc, log) VALUES(?, ?, ${NEW_LOG})`,
				channel,
				doc,
			);
		}
		const seq = (row?.head ?? 0) + 1;
		this.sql.exec(
			"INSERT INTO deltas(channel, doc, seq, blob) VALUES(?, ?, ?, ?)",
			channel,
			doc,
			seq,
			blob(payload),
		);
		return seq;
	}

	state(channel: string, doc: string, since: number): DocState {
		const row = this.row(channel, doc);
		if (!row) return { head: 0, snapshot: null, deltas: [], log: "" };
		const withSnapshot = since < row.snapSeq;
		const deltas = this.sql
			.exec(
				"SELECT blob FROM deltas WHERE channel = ? AND doc = ? AND seq > ? ORDER BY seq",
				channel,
				doc,
				Math.max(since, row.snapSeq),
			)
			.toArray()
			.map((delta) => bytes(delta.blob));
		return {
			head: row.head,
			snapshot: withSnapshot ? this.snapshot(channel, doc) : null,
			deltas,
			log: row.log,
		};
	}

	compact(
		channel: string,
		doc: string,
		payload: Uint8Array,
		upto: number,
	): void {
		const row = this.row(channel, doc);
		if (!row || payload.length === 0) return;
		const covered = Math.min(upto, row.head);
		if (covered <= row.snapSeq) return;
		this.sql.exec(
			"UPDATE docs SET snap = ?, snap_seq = ? WHERE channel = ? AND doc = ?",
			blob(payload),
			covered,
			channel,
			doc,
		);
		this.sql.exec(
			"DELETE FROM deltas WHERE channel = ? AND doc = ? AND seq <= ?",
			channel,
			doc,
			covered,
		);
	}

	private row(channel: string, doc: string): DocRow | null {
		const [row] = this.sql
			.exec(
				"SELECT snap_seq, moved, log, (SELECT max(seq) FROM deltas WHERE channel = docs.channel AND doc = docs.doc) AS last FROM docs WHERE channel = ? AND doc = ?",
				channel,
				doc,
			)
			.toArray();
		if (!row) return null;
		const snapSeq = Number(row.snap_seq);
		return {
			// Compaction can leave no delta, and a moved log has neither.
			head: Math.max(Number(row.last), snapSeq),
			snapSeq,
			moved: typeof row.moved === "string" ? row.moved : null,
			log: typeof row.log === "string" ? row.log : "",
		};
	}

	private snapshot(channel: string, doc: string): Uint8Array | null {
		const [row] = this.sql
			.exec("SELECT snap FROM docs WHERE channel = ? AND doc = ?", channel, doc)
			.toArray();
		return row?.snap ? bytes(row.snap) : null;
	}
}

function blob(payload: Uint8Array): ArrayBuffer {
	return payload.slice().buffer;
}

/** workerd returns ArrayBuffer, node:sqlite a Uint8Array. */
function bytes(value: SqlValue | undefined): Uint8Array {
	return new Uint8Array(value as ArrayBuffer);
}
