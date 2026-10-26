import { describe, expect, it } from "vitest";

import {
	CHUNK_BYTES,
	MAX_TAIL_BYTES,
	MAX_TAIL_DELTAS,
	MOVED_CACHE_MAX,
	SqlDocStore,
	type TransactionalSql,
} from "../../src/hub/store";
import { limited, loggedSql, memorySql } from "../helpers/memory-sql";

const VAULT = "vault-channel";
const OTHER = "other-channel";
const DOC = "a".repeat(32);
const NEXT = "b".repeat(32);

const bytes = (...values: number[]) => Uint8Array.from(values);
/** With its 4-byte length, a quarter of the tail cap. */
const quarter = () => new Uint8Array(MAX_TAIL_BYTES / 4 - 4);
/** Four to a chunk, with their lengths. */
const fourth = (fill: number) => new Uint8Array(CHUNK_BYTES / 4 - 4).fill(fill);

const chunks = (sql: TransactionalSql, doc = DOC) =>
	sql
		.exec("SELECT first, last FROM chunks WHERE doc = ? ORDER BY first", doc)
		.toArray();
const tables = (sql: TransactionalSql) =>
	sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.toArray()
		.map((row) => row.name);

describe("a log nothing compacts", () => {
	it("takes no delta past the count cap, until a snapshot covers the log", () => {
		const store = new SqlDocStore(memorySql());
		for (let at = 0; at < MAX_TAIL_DELTAS; at++)
			store.append(VAULT, DOC, bytes(1));

		expect(store.append(VAULT, DOC, bytes(1))).toBeNull();
		store.compact(VAULT, DOC, bytes(9), MAX_TAIL_DELTAS);
		expect(store.append(VAULT, DOC, bytes(1))).toBe(MAX_TAIL_DELTAS + 1);
	});

	it("takes no delta past the byte cap", () => {
		const store = new SqlDocStore(memorySql());
		for (let at = 1; at <= 4; at++) {
			expect(store.append(VAULT, DOC, quarter())).toBe(at);
		}

		expect(store.append(VAULT, DOC, bytes(1))).toBeNull();
	});
});

describe("what an update costs", () => {
	it("writes its chunk row only, once the document exists", () => {
		const sql = loggedSql();
		const store = new SqlDocStore(sql);
		store.append(VAULT, DOC, bytes(1));
		sql.writes.length = 0;

		store.append(VAULT, DOC, bytes(2));
		store.append(VAULT, DOC, bytes(3));

		expect(sql.writes).toEqual([
			expect.stringContaining("UPDATE chunks"),
			expect.stringContaining("UPDATE chunks"),
		]);
	});

	it("keeps 200 typed updates in 5 rows, all their compaction deletes", () => {
		const sql = memorySql();
		const store = new SqlDocStore(sql);
		for (let at = 0; at < 200; at++) {
			store.append(VAULT, DOC, new Uint8Array(94));
		}

		expect(chunks(sql)).toHaveLength(5);
	});

	it("derives the head from the log's end, and from the snapshot once compaction took every delta", () => {
		const store = new SqlDocStore(memorySql());
		for (const byte of [1, 2, 3]) store.append(VAULT, DOC, bytes(byte));

		store.compact(VAULT, DOC, bytes(9), 3);
		expect(store.state(VAULT, DOC, 0)).toMatchObject({
			head: 3,
			snapshot: bytes(9),
			deltas: [],
		});
		expect(store.append(VAULT, DOC, bytes(4))).toBe(4);
		expect(store.rotate(VAULT, DOC, to(NEXT), 4, bytes(5))).toBe(true);
		expect(store.state(VAULT, DOC, 0)).toMatchObject({ head: 0 });
	});
});

describe("forwarding pointers", () => {
	it("asks the table about a document once, however many frames follow", () => {
		const sql = loggedSql();
		const store = new SqlDocStore(sql);
		sql.queries.length = 0;

		for (let frame = 0; frame < 5; frame++) store.movedTo(VAULT, DOC);

		expect(sql.queries).toHaveLength(1);
	});

	it("sees a rotation and a purge through the answers it kept", () => {
		const store = new SqlDocStore(memorySql());
		store.append(VAULT, DOC, bytes(1));
		expect(store.movedTo(VAULT, DOC)).toBeNull();
		expect(store.movedTo(OTHER, DOC)).toBeNull();

		expect(store.rotate(VAULT, DOC, to(NEXT, bytes(7)), 1, bytes(2))).toBe(
			true,
		);
		expect(store.movedTo(VAULT, DOC)).toEqual(to(NEXT, bytes(7)));
		expect(store.movedTo(OTHER, DOC)).toBeNull();

		store.purge(VAULT);
		expect(store.movedTo(VAULT, DOC)).toBeNull();
	});

	it("keeps the pointer and its note across a restart", () => {
		const sql = memorySql();
		const before = new SqlDocStore(sql);
		before.append(VAULT, DOC, bytes(1));
		before.rotate(VAULT, DOC, to(NEXT, bytes(7, 8)), 1, bytes(2));
		before.append(VAULT, "plain", bytes(1));
		before.rotate(VAULT, "plain", to(`${NEXT}2`), 1, bytes(2));

		const after = new SqlDocStore(sql);
		expect(after.movedTo(VAULT, DOC)).toEqual(to(NEXT, bytes(7, 8)));
		expect(after.movedTo(VAULT, "plain")).toEqual(to(`${NEXT}2`));
	});

	it("keeps a bounded number of answers, the oldest going first", () => {
		const sql = loggedSql();
		const store = new SqlDocStore(sql);
		for (let doc = 0; doc <= MOVED_CACHE_MAX; doc++) {
			store.movedTo(VAULT, `doc-${doc}`);
		}
		sql.queries.length = 0;

		store.movedTo(VAULT, `doc-${MOVED_CACHE_MAX}`);
		expect(sql.queries).toHaveLength(0);
		store.movedTo(VAULT, "doc-0");
		expect(sql.queries).toHaveLength(1);
	});
});

describe("purging a channel", () => {
	it("deletes its logs, snapshots and pointers, and a regrown log has another name", () => {
		const store = new SqlDocStore(memorySql());
		store.append(VAULT, DOC, bytes(1));
		store.append(VAULT, DOC, bytes(2));
		store.compact(VAULT, DOC, bytes(9), 2);
		store.append(VAULT, "moving", bytes(3));
		store.rotate(VAULT, "moving", to(NEXT), 1, bytes(4));
		store.append(OTHER, DOC, bytes(5));
		const { log } = store.state(VAULT, DOC, 0);

		store.purge(VAULT);

		expect(store.state(VAULT, DOC, 0)).toEqual({
			head: 0,
			snapshot: null,
			deltas: [],
			log: "",
		});
		expect(store.movedTo(VAULT, "moving")).toBeNull();
		expect(store.state(VAULT, NEXT, 0).head).toBe(0);
		expect(store.state(OTHER, DOC, 0)).toMatchObject({
			head: 1,
			deltas: [bytes(5)],
		});
		store.append(VAULT, DOC, bytes(6));
		expect(store.state(VAULT, DOC, 0)).toMatchObject({ head: 1 });
		expect(store.state(VAULT, DOC, 0).log).not.toBe(log);
	});
});

function to(target: string, note = bytes()) {
	return { target, note };
}

describe("the tail's byte count", () => {
	const sums = (sql: { queries: string[] }) =>
		sql.queries.filter((query) => query.includes("sum(length")).length;

	it("is summed once after a wake, however many updates follow", () => {
		const sql = loggedSql();
		new SqlDocStore(sql).append(VAULT, DOC, bytes(1));
		const store = new SqlDocStore(sql);
		for (let at = 0; at < 20; at++) store.append(VAULT, DOC, bytes(1));

		expect(sums(sql)).toBe(1);
	});

	it("still caps the bytes after a compaction, which counts the tail afresh", () => {
		const store = new SqlDocStore(memorySql());
		for (let at = 1; at <= 4; at++) store.append(VAULT, DOC, quarter());
		expect(store.append(VAULT, DOC, bytes(1))).toBeNull();

		store.compact(VAULT, DOC, bytes(9), 4);
		expect(store.append(VAULT, DOC, quarter())).toBe(5);
		store.append(VAULT, DOC, quarter());
		store.append(VAULT, DOC, quarter());
		store.append(VAULT, DOC, quarter());
		expect(store.append(VAULT, DOC, bytes(1))).toBeNull();
	});

	it("caps bytes in a fresh store over the same SQL, and after eviction", () => {
		const sql = memorySql();
		const before = new SqlDocStore(sql);
		for (let at = 1; at <= 4; at++) before.append(VAULT, DOC, quarter());

		const after = new SqlDocStore(sql);
		expect(after.append(VAULT, DOC, bytes(1))).toBeNull();

		for (let doc = 0; doc <= MOVED_CACHE_MAX; doc++) {
			after.append(VAULT, `doc-${doc}`, bytes(1));
		}
		expect(after.append(VAULT, DOC, bytes(1))).toBeNull();
	});

	it("starts again after a rotation and a purge", () => {
		const store = new SqlDocStore(memorySql());
		for (let at = 1; at <= 4; at++) store.append(VAULT, DOC, quarter());
		expect(store.rotate(VAULT, DOC, to(NEXT), 4, bytes(1))).toBe(true);
		expect(store.append(VAULT, NEXT, bytes(1))).toBe(2);

		for (let at = 1; at <= 4; at++) store.append(OTHER, DOC, quarter());
		store.purge(OTHER);
		expect(store.append(OTHER, DOC, quarter())).toBe(1);
	});
});

describe("chunks", () => {
	it("take deltas until CHUNK_BYTES, a bigger one alone", () => {
		const sql = memorySql();
		const store = new SqlDocStore(sql);
		for (let at = 1; at <= 5; at++) store.append(VAULT, DOC, fourth(at));
		store.append(VAULT, DOC, new Uint8Array(CHUNK_BYTES));
		store.append(VAULT, DOC, bytes(7));

		expect(chunks(sql)).toEqual([
			{ first: 1, last: 4 },
			{ first: 5, last: 5 },
			{ first: 6, last: 6 },
			{ first: 7, last: 7 },
		]);
	});

	it("read back exactly the deltas after any since, a compaction keeping the chunk it splits", () => {
		const sql = memorySql();
		const store = new SqlDocStore(sql);
		const sent = Array.from({ length: 30 }, (_, at) => fourth(at));
		for (const delta of sent) store.append(VAULT, DOC, delta);

		store.compact(VAULT, DOC, bytes(99), 22);

		expect(chunks(sql)[0]).toEqual({ first: 21, last: 24 });
		for (let since = 0; since <= 30; since++) {
			expect(store.state(VAULT, DOC, since)).toEqual({
				head: 30,
				snapshot: since < 22 ? bytes(99) : null,
				deltas: sent.slice(Math.max(since, 22)),
				log: expect.any(String),
			});
		}
	});

	it("keep every byte value", () => {
		const store = new SqlDocStore(memorySql());
		const all = Uint8Array.from({ length: 256 }, (_, at) => at);
		const reversed = all.slice().reverse();
		store.append(VAULT, DOC, all);
		store.append(VAULT, DOC, reversed);

		expect(store.state(VAULT, DOC, 0).deltas).toEqual([all, reversed]);
	});
});

describe("a 1.3 store", () => {
	const EMPTY = { head: 0, snapshot: null, deltas: [], log: "" };
	const DELTAS =
		"CREATE TABLE deltas(channel TEXT, doc TEXT, seq INTEGER, blob BLOB NOT NULL, PRIMARY KEY(channel, doc, seq)) WITHOUT ROWID";
	const oldDelta = (
		sql: TransactionalSql,
		channel: string,
		doc: string,
		seq: number,
		delta: Uint8Array,
	) =>
		sql.exec(
			"INSERT INTO deltas VALUES(?, ?, ?, ?)",
			channel,
			doc,
			seq,
			delta.slice().buffer,
		);

	/** A delta per row: a snapshot at 2, then 3 to 5, and a log in another channel. */
	function legacy(): TransactionalSql {
		const sql = memorySql();
		sql.exec(
			"CREATE TABLE docs(channel TEXT, doc TEXT, snap_seq INTEGER NOT NULL DEFAULT 0, moved TEXT, moved_note BLOB, snap BLOB, log TEXT, PRIMARY KEY(channel, doc)) WITHOUT ROWID",
		);
		sql.exec(DELTAS);
		sql.exec(
			"INSERT INTO docs(channel, doc, snap_seq, snap, log) VALUES(?, ?, 2, ?, 'old'), (?, ?, 0, NULL, 'other')",
			VAULT,
			DOC,
			bytes(9).buffer,
			OTHER,
			DOC,
		);
		oldDelta(sql, VAULT, DOC, 3, bytes(3, 255));
		oldDelta(sql, VAULT, DOC, 4, bytes());
		oldDelta(sql, VAULT, DOC, 5, bytes(5, 0, 128));
		oldDelta(sql, OTHER, DOC, 1, bytes(1));
		return sql;
	}

	it("packs each log into chunks, which read and grow as before", () => {
		const sql = legacy();
		const store = new SqlDocStore(sql);

		expect(tables(sql)).toEqual(["chunks", "docs"]);
		expect(chunks(sql)).toEqual([
			{ first: 1, last: 1 },
			{ first: 3, last: 5 },
		]);
		expect(store.state(VAULT, DOC, 0)).toEqual({
			head: 5,
			snapshot: bytes(9),
			deltas: [bytes(3, 255), bytes(), bytes(5, 0, 128)],
			log: "old",
		});
		expect(store.state(OTHER, DOC, 0).deltas).toEqual([bytes(1)]);
		expect(store.append(VAULT, DOC, bytes(6))).toBe(6);
		expect(store.state(VAULT, DOC, 4).deltas).toEqual([
			bytes(5, 0, 128),
			bytes(6),
		]);
	});

	it("starts the next chunk past CHUNK_BYTES", () => {
		const sql = legacy();
		const sent = Array.from({ length: 9 }, (_, at) => fourth(at));
		for (const [at, delta] of sent.entries()) {
			oldDelta(sql, VAULT, NEXT, at + 1, delta);
		}
		sql.exec(
			"INSERT INTO docs(channel, doc, log) VALUES(?, ?, 'long')",
			VAULT,
			NEXT,
		);

		const store = new SqlDocStore(sql);

		expect(chunks(sql, NEXT)).toEqual([
			{ first: 1, last: 4 },
			{ first: 5, last: 8 },
			{ first: 9, last: 9 },
		]);
		expect(store.state(VAULT, NEXT, 0).deltas).toEqual(sent);
	});

	it("waits for writes enough to move it, refusing frames meanwhile, not the hub", () => {
		const sql = legacy();
		const quota = { writes: 0 };
		const store = new SqlDocStore(limited(sql, quota));
		expect(tables(sql)).toEqual(["deltas", "docs"]);
		expect(() => store.atomic(() => store.state(VAULT, DOC, 0))).toThrow();

		quota.writes = Number.POSITIVE_INFINITY;
		expect(store.atomic(() => store.state(VAULT, DOC, 0)).head).toBe(5);
		expect(tables(sql)).toEqual(["chunks", "docs"]);
	});

	it("found beside the chunks, as a rollback appended to it, starts the logs over and keeps the pointers", () => {
		const sql = memorySql();
		const before = new SqlDocStore(sql);
		before.append(VAULT, DOC, bytes(1));
		before.append(VAULT, "moving", bytes(1));
		before.rotate(VAULT, "moving", to(NEXT, bytes(7)), 1, bytes(2));
		sql.exec(DELTAS);
		oldDelta(sql, VAULT, DOC, 1, bytes(3));

		const after = new SqlDocStore(sql);

		expect(tables(sql)).toEqual(["chunks", "docs"]);
		expect(after.state(VAULT, DOC, 0)).toEqual(EMPTY);
		expect(after.state(VAULT, NEXT, 0)).toEqual(EMPTY);
		expect(after.movedTo(VAULT, "moving")).toEqual(to(NEXT, bytes(7)));
	});
});
