import { describe, expect, it } from "vitest";

import { MOVED_CACHE_MAX, SqlDocStore } from "../src/hub-store";
import { loggedSql, memorySql } from "./helpers/memory-sql";

const VAULT = "vault-channel";
const OTHER = "other-channel";
const DOC = "a".repeat(32);
const NEXT = "b".repeat(32);

const bytes = (...values: number[]) => Uint8Array.from(values);

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
		expect(store.rotate(VAULT, DOC, NEXT, 4, bytes(5))).toBe(true);
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

		expect(store.rotate(VAULT, DOC, NEXT, 1, bytes(2))).toBe(true);
		expect(store.movedTo(VAULT, DOC)).toBe(NEXT);
		expect(store.movedTo(OTHER, DOC)).toBeNull();

		store.purge(VAULT);
		expect(store.movedTo(VAULT, DOC)).toBeNull();
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
		store.rotate(VAULT, "moving", NEXT, 1, bytes(4));
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
