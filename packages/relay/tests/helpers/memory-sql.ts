import { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "../../src/hub-store";

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
