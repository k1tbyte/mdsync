/**
 * Document logs in the Durable Object's SQLite, all ciphertext: a row per document and chunks of consecutive
 * deltas, each after its 4-byte length; the head is the last chunk's last seq.
 */

import type { DocState, DocStore, Pointer } from "./docs";

/** `SqlStorageValue`, spelled out so code without workers-types can import this. */
export type SqlValue = ArrayBuffer | string | number | null;

export interface Sql {
	exec(
		query: string,
		...bindings: SqlValue[]
	): { toArray(): Record<string, SqlValue>[] };
}

export interface TransactionalSql extends Sql {
	/** Rolls back what `run` wrote when it throws. */
	transactionSync<T>(run: () => T): T;
}

interface DocRow {
	head: number;
	snapSeq: number;
	moved: string | null;
	log: string;
	/** The chunk ending at the head. */
	last: { first: number; bytes: number } | null;
}

const NEW_LOG = "lower(hex(randomblob(8)))";

const CHUNKS =
	"CREATE TABLE IF NOT EXISTS chunks(channel TEXT, doc TEXT, first INTEGER, last INTEGER NOT NULL, blob BLOB NOT NULL, PRIMARY KEY(channel, doc, first)) WITHOUT ROWID";
const NEW_CHUNK =
	"INSERT INTO chunks(channel, doc, first, last, blob) VALUES(?, ?, ?, ?, ?)";

/** An append or a delete costs one row however much it holds; past this a chunk takes no more, as each append rewrites it. */
export const CHUNK_BYTES = 4096;
const HEADER = 4;

/** `movedTo` is asked on every frame and a pointer never changes once set, so answers are kept, oldest out first. */
export const MOVED_CACHE_MAX = 1024;

/** A log no client compacts (its snapshot outgrew a frame, or a writer misbehaves) takes no more writes. */
export const MAX_TAIL_DELTAS = 2_000;
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

const cacheKey = (channel: string, doc: string) =>
	`${channel.length}:${channel}${doc}`;

export class SqlDocStore implements DocStore {
	private readonly moved = new Map<string, Pointer | null>();
	/** Bytes of each log's tail, so an update need not sum the rows again; every delta delete forgets it. */
	private readonly tails = new Map<string, number>();
	/** A 1.3 store not moved yet: the day's writes could not cover it. */
	private legacy: boolean;

	constructor(private readonly sql: TransactionalSql) {
		sql.exec(
			"CREATE TABLE IF NOT EXISTS docs(channel TEXT, doc TEXT, snap_seq INTEGER NOT NULL DEFAULT 0, moved TEXT, moved_note BLOB, snap BLOB, log TEXT, PRIMARY KEY(channel, doc)) WITHOUT ROWID",
		);
		this.legacy = tablesOf(sql).has("deltas");
		if (!this.legacy) sql.exec(CHUNKS);
		try {
			this.settle();
		} catch {
			// Retried by every frame, whose refusal logs it: the hub's other work goes on meanwhile.
		}
	}

	private settle(): void {
		if (!this.legacy) return;
		this.sql.transactionSync(() => moveDeltas(this.sql));
		this.legacy = false;
	}

	atomic<T>(run: () => T): T {
		this.settle();
		try {
			return this.sql.transactionSync(run);
		} catch (error) {
			// Rolled back: what the caches learnt meanwhile may never have been stored.
			this.moved.clear();
			this.tails.clear();
			throw error;
		}
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
		remember(this.moved, key, pointer);
		return pointer;
	}

	purge(channel: string): void {
		this.settle();
		this.sql.exec("DELETE FROM chunks WHERE channel = ?", channel);
		this.sql.exec("DELETE FROM docs WHERE channel = ?", channel);
		this.moved.clear();
		this.tails.clear();
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

	private markMoved(channel: string, doc: string, pointer: Pointer): void {
		this.sql.exec(
			"INSERT INTO docs(channel, doc, moved, moved_note) VALUES(?, ?, ?, ?) ON CONFLICT(channel, doc) DO UPDATE SET snap_seq = 0, snap = NULL, moved = excluded.moved, moved_note = excluded.moved_note",
			channel,
			doc,
			pointer.target,
			blob(pointer.note),
		);
		this.sql.exec(
			"DELETE FROM chunks WHERE channel = ? AND doc = ?",
			channel,
			doc,
		);
		remember(this.moved, cacheKey(channel, doc), pointer);
		this.tails.delete(cacheKey(channel, doc));
	}

	append(channel: string, doc: string, payload: Uint8Array): number | null {
		const row = this.row(channel, doc);
		if (!row) return this.insert(channel, doc, payload, row, 0);
		// Counted first, so the byte sum reads at most MAX_TAIL_DELTAS rows.
		if (row.head - row.snapSeq >= MAX_TAIL_DELTAS) return null;
		const used = this.tailBytes(channel, doc, row);
		if (used + HEADER + payload.length > MAX_TAIL_BYTES) return null;
		return this.insert(channel, doc, payload, row, used);
	}

	private tailBytes(channel: string, doc: string, row: DocRow): number {
		const key = cacheKey(channel, doc);
		const known = this.tails.get(key);
		if (known !== undefined) return known;
		const [tail] = this.sql
			.exec(
				"SELECT coalesce(sum(length(blob)), 0) AS bytes FROM chunks WHERE channel = ? AND doc = ? AND last > ?",
				channel,
				doc,
				row.snapSeq,
			)
			.toArray();
		return Number(tail?.bytes);
	}

	seed(channel: string, doc: string, payload: Uint8Array): number | null {
		const row = this.row(channel, doc);
		return row ? null : this.insert(channel, doc, payload, row, 0);
	}

	private insert(
		channel: string,
		doc: string,
		payload: Uint8Array,
		row: DocRow | null,
		used: number,
	): number {
		if (!row) {
			this.sql.exec(
				`INSERT INTO docs(channel, doc, log) VALUES(?, ?, ${NEW_LOG})`,
				channel,
				doc,
			);
		}
		const seq = (row?.head ?? 0) + 1;
		const framed = frame([payload]);
		const last = row?.last;
		if (last && last.bytes + framed.byteLength <= CHUNK_BYTES) {
			this.sql.exec(
				"UPDATE chunks SET blob = CAST(blob || ? AS BLOB), last = ? WHERE channel = ? AND doc = ? AND first = ?",
				framed,
				seq,
				channel,
				doc,
				last.first,
			);
		} else {
			this.sql.exec(NEW_CHUNK, channel, doc, seq, seq, framed);
		}
		remember(this.tails, cacheKey(channel, doc), used + framed.byteLength);
		return seq;
	}

	state(channel: string, doc: string, since: number): DocState {
		const row = this.row(channel, doc);
		if (!row) return { head: 0, snapshot: null, deltas: [], log: "" };
		const withSnapshot = since < row.snapSeq;
		const after = Math.max(since, row.snapSeq);
		const deltas = this.sql
			.exec(
				"SELECT first, blob FROM chunks WHERE channel = ? AND doc = ? AND last > ? ORDER BY first",
				channel,
				doc,
				after,
			)
			.toArray()
			.flatMap((chunk) =>
				deltasAfter(bytes(chunk.blob), Number(chunk.first), after),
			);
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
		// A chunk reaching past `covered` stays whole: `state` skips what the snapshot holds.
		this.sql.exec(
			"DELETE FROM chunks WHERE channel = ? AND doc = ? AND last <= ?",
			channel,
			doc,
			covered,
		);
		this.tails.delete(cacheKey(channel, doc));
	}

	private row(channel: string, doc: string): DocRow | null {
		const [row] = this.sql
			.exec(
				"SELECT snap_seq, moved, log FROM docs WHERE channel = ? AND doc = ?",
				channel,
				doc,
			)
			.toArray();
		if (!row) return null;
		const [chunk] = this.sql
			.exec(
				"SELECT first, last, length(blob) AS bytes FROM chunks WHERE channel = ? AND doc = ? ORDER BY first DESC LIMIT 1",
				channel,
				doc,
			)
			.toArray();
		const snapSeq = Number(row.snap_seq);
		return {
			// Compaction can leave no chunk, and a moved log has neither.
			head: Math.max(Number(chunk?.last ?? 0), snapSeq),
			snapSeq,
			moved: typeof row.moved === "string" ? row.moved : null,
			log: typeof row.log === "string" ? row.log : "",
			last: chunk
				? { first: Number(chunk.first), bytes: Number(chunk.bytes) }
				: null,
		};
	}

	private snapshot(channel: string, doc: string): Uint8Array | null {
		const [row] = this.sql
			.exec("SELECT snap FROM docs WHERE channel = ? AND doc = ?", channel, doc)
			.toArray();
		return row?.snap ? bytes(row.snap) : null;
	}
}

function tablesOf(sql: Sql): Set<string> {
	return new Set(
		sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
			.toArray()
			.map((row) => String(row.name)),
	);
}

/**
 * 1.3 kept a row per delta in `deltas`; packed, the move writes a row per chunk. Found beside `chunks`, it
 * holds a rollback's appends under seqs the chunks already use: the logs start over as if lost, the pointers
 * stay so devices still find a note's latest room. Run in one transaction, so `chunks` alone means moved.
 */
function moveDeltas(sql: TransactionalSql): void {
	if (tablesOf(sql).has("chunks")) {
		sql.exec("DELETE FROM chunks");
		sql.exec("DELETE FROM docs WHERE moved IS NULL");
	} else {
		sql.exec(CHUNKS);
		for (const log of sql
			.exec("SELECT DISTINCT channel, doc FROM deltas")
			.toArray()) {
			pack(sql, String(log.channel), String(log.doc));
		}
	}
	sql.exec("DROP TABLE deltas");
}

function pack(sql: TransactionalSql, channel: string, doc: string): void {
	let chunk: {
		first: number;
		last: number;
		deltas: Uint8Array[];
		bytes: number;
	} | null = null;
	const write = () =>
		chunk &&
		sql.exec(
			NEW_CHUNK,
			channel,
			doc,
			chunk.first,
			chunk.last,
			frame(chunk.deltas),
		);
	for (const row of sql
		.exec(
			"SELECT seq, blob FROM deltas WHERE channel = ? AND doc = ? ORDER BY seq",
			channel,
			doc,
		)
		.toArray()) {
		const seq = Number(row.seq);
		const delta = bytes(row.blob);
		const size = HEADER + delta.length;
		if (!chunk || seq !== chunk.last + 1 || chunk.bytes + size > CHUNK_BYTES) {
			write();
			chunk = { first: seq, last: seq, deltas: [], bytes: 0 };
		}
		chunk.deltas.push(delta);
		chunk.last = seq;
		chunk.bytes += size;
	}
	write();
}

/** Each delta after its 4-byte length. */
function frame(deltas: Uint8Array[]): ArrayBuffer {
	const out = new Uint8Array(
		deltas.reduce((sum, delta) => sum + HEADER + delta.length, 0),
	);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const delta of deltas) {
		view.setUint32(at, delta.length);
		out.set(delta, at + HEADER);
		at += HEADER + delta.length;
	}
	return out.buffer;
}

/** The chunk's deltas past `after`, its first being `first`. */
function deltasAfter(
	chunk: Uint8Array,
	first: number,
	after: number,
): Uint8Array[] {
	const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	const deltas: Uint8Array[] = [];
	for (let at = 0, seq = first; at < chunk.length; seq++) {
		const end = at + HEADER + view.getUint32(at);
		if (seq > after) deltas.push(chunk.subarray(at + HEADER, end));
		at = end;
	}
	return deltas;
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
	if (cache.size >= MOVED_CACHE_MAX && !cache.has(key)) {
		cache.delete(cache.keys().next().value as string);
	}
	cache.set(key, value);
}

function blob(payload: Uint8Array): ArrayBuffer {
	return payload.slice().buffer;
}

/** workerd returns ArrayBuffer, node:sqlite a Uint8Array. */
function bytes(value: SqlValue | undefined): Uint8Array {
	return new Uint8Array(value as ArrayBuffer);
}
