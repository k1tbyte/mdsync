import { describe, expect, it } from "vitest";
import { pendingMigrations } from "@/cloudflare/migrations";

const MIGRATIONS = [
	{ tag: "v1", new_sqlite_classes: ["SyncRelay"] },
	{ tag: "v2", new_sqlite_classes: ["Hub"], deleted_classes: ["SyncRelay"] },
	{ tag: "v3", new_sqlite_classes: ["Link"] },
];

describe("pendingMigrations", () => {
	it("sends every step to a fresh relay, without an old tag", () => {
		expect(pendingMigrations(MIGRATIONS, undefined)).toEqual({
			new_tag: "v3",
			steps: [
				{ new_sqlite_classes: ["SyncRelay"] },
				{ new_sqlite_classes: ["Hub"], deleted_classes: ["SyncRelay"] },
				{ new_sqlite_classes: ["Link"] },
			],
		});
	});

	it("sends only the steps after the deployed tag", () => {
		expect(pendingMigrations(MIGRATIONS, "v2")).toEqual({
			old_tag: "v2",
			new_tag: "v3",
			steps: [{ new_sqlite_classes: ["Link"] }],
		});
	});

	it("sends nothing to a relay already at the last tag", () => {
		expect(pendingMigrations(MIGRATIONS, "v3")).toBeUndefined();
	});

	it("refuses a deployed tag it does not know instead of replaying history", () => {
		expect(() => pendingMigrations(MIGRATIONS, "v9")).toThrow(/v9/);
	});
});
