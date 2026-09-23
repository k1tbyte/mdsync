// The slice of node:sqlite the tests use; @types/node would clash with workers-types.
declare module "node:sqlite" {
	interface StatementSync {
		columns(): unknown[];
		all(...params: unknown[]): unknown[];
		run(...params: unknown[]): unknown;
	}
	export class DatabaseSync {
		constructor(path: string);
		prepare(sql: string): StatementSync;
	}
}
