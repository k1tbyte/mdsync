import { describe, expect, it } from "vitest";

import {
	MAX_TAIL_BYTES,
	MAX_TAIL_DELTAS,
	MOVED_CACHE_MAX,
	SqlDocStore,
} from "../../src/hub/store";
import { loggedSql, memorySql } from "../helpers/memory-sql";

const VAULT = "vault-channel";
const OTHER = "other-channel";
const DOC = "a".repeat(32);
const NEXT = "b".repeat(32);

const bytes = (...values: number[]) => Uint8Array.from(values);

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
		const quarter = new Uint8Array(MAX_TAIL_BYTES / 4);
		for (let at = 1; at <= 4; at++) {
			expect(store.append(VAULT, DOC, quarter)).toBe(at);
		}

		expect(store.append(VAULT, DOC, bytes(1))).toBeNull();
	});
});

describe("what an update costs", () => {
	it("writes the delta row only, once the document exists", () => {
		const sql = loggedSql();
		const store = new SqlDocStore(sql);
		store.append(VAULT, DOC, bytes(1));
		sql.writes.length = 0;

		store.append(VAULT, DOC, bytes(2));
		store.append(VAULT, DOC, bytes(3));

		expect(sql.writes).toEqual([
			expect.stringContaining("INSERT INTO deltas"),
			expect.stringContaining("INSERT INTO deltas"),
		]);
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
	const quarter = () => new Uint8Array(MAX_TAIL_BYTES / 4);
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
