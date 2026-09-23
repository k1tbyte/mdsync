/**
 * The hub's document logs in the Durable Object's SQLite: one row per delta and
 * one per document (head, snapshot, forwarding pointer). All of it ciphertext.
 */

import type { DocState, DocStore } from "./hub-docs";

/** The slice of `SqlStorage` used here, so tests can back it with node:sqlite. */
export interface Sql {
	exec(
		query: string,
		...bindings: SqlStorageValue[]
	): { toArray(): Record<string, SqlStorageValue>[] };
}

interface DocRow {
	head: number;
	snapSeq: number;
	moved: string | null;
}

export class SqlDocStore implements DocStore {
	constructor(private readonly sql: Sql) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS docs(channel TEXT, doc TEXT, head INTEGER NOT NULL, snap_seq INTEGER NOT NULL DEFAULT 0, moved TEXT, snap BLOB, PRIMARY KEY(channel, doc))",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS deltas(channel TEXT, doc TEXT, seq INTEGER, blob BLOB NOT NULL, PRIMARY KEY(channel, doc, seq))",
		);
	}

	movedTo(channel: string, doc: string): string | null {
		return this.row(channel, doc)?.moved ?? null;
	}

	markMoved(channel: string, doc: string, target: string): void {
		this.sql.exec(
			"INSERT INTO docs(channel, doc, head, moved) VALUES(?, ?, 0, ?) ON CONFLICT(channel, doc) DO UPDATE SET head = 0, snap_seq = 0, snap = NULL, moved = excluded.moved",
			channel,
			doc,
			target,
		);
		this.sql.exec(
			"DELETE FROM deltas WHERE channel = ? AND doc = ?",
			channel,
			doc,
		);
	}

	append(channel: string, doc: string, payload: Uint8Array): number {
		const [row] = this.sql
			.exec(
				"INSERT INTO docs(channel, doc, head) VALUES(?, ?, 1) ON CONFLICT(channel, doc) DO UPDATE SET head = head + 1 RETURNING head",
				channel,
				doc,
			)
			.toArray();
		const seq = Number(row?.head);
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
		if (!row) return { head: 0, snapshot: null, deltas: [] };
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
				"SELECT head, snap_seq, moved FROM docs WHERE channel = ? AND doc = ?",
				channel,
				doc,
			)
			.toArray();
		if (!row) return null;
		return {
			head: Number(row.head),
			snapSeq: Number(row.snap_seq),
			moved: typeof row.moved === "string" ? row.moved : null,
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
function bytes(value: SqlStorageValue): Uint8Array {
	return new Uint8Array(value as ArrayBuffer);
}
