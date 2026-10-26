import { DatabaseSync } from "node:sqlite";

import type { SqlValue, TransactionalSql } from "../../src/hub/store";

/** node:sqlite behind the Durable Object's `sql.exec` shape; the plugin's tests use it too. */
export function memorySql(): TransactionalSql {
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
		transactionSync(run) {
			db.exec("SAVEPOINT tx");
			try {
				const result = run();
				db.exec("RELEASE tx");
				return result;
			} catch (error) {
				db.exec("ROLLBACK TO tx");
				db.exec("RELEASE tx");
				throw error;
			}
		},
	};
}

/** A `sql` that remembers every statement, so a test can count what an operation costs. */
export function loggedSql(
	sql: TransactionalSql = memorySql(),
): TransactionalSql & {
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
		transactionSync: (run) => sql.transactionSync(run),
	};
}

/** Throws on the queries `fails` picks, as storage past its day's limits does. */
export function failing(
	sql: TransactionalSql,
	fails: (query: string) => boolean,
): TransactionalSql {
	return {
		exec(query, ...bindings) {
			if (fails(query)) throw new Error("Exceeded allowed rows");
			return sql.exec(query, ...bindings);
		},
		transactionSync: (run) => sql.transactionSync(run),
	};
}

/** Lets `quota.writes` more writes through, then fails each. */
export function limited(sql: TransactionalSql, quota: { writes: number }) {
	return failing(
		sql,
		(query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query) && quota.writes-- <= 0,
	);
}
