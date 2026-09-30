import { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "../../src/hub/store";

/** node:sqlite behind the Durable Object's `sql.exec` shape; the plugin's tests use it too. */
export function memorySql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query, ...bindings) {
			const statement = db.prepare(query);
			const params = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value,
			);
			if (statement.columns().length === 0) {
				statement.run(...params);
				return { toArray: () => [] };
			}
			const rows = statement.all(...params) as Record<string, SqlValue>[];
			return { toArray: () => rows };
		},
	};
}

/** A `sql` that remembers every statement, so a test can count what an operation costs. */
export function loggedSql(sql: Sql = memorySql()): Sql & {
	queries: string[];
	writes: string[];
} {
	const queries: string[] = [];
	const writes: string[] = [];
	return {
		queries,
		writes,
		exec(query, ...bindings) {
			queries.push(query);
			if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) writes.push(query);
			return sql.exec(query, ...bindings);
		},
	};
}
