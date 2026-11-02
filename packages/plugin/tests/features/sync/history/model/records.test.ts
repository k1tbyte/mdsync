import { describe, expect, it } from "vitest";
import { hourOf } from "@/features/sync/history/model/periods";
import { storedRecord, thin } from "@/features/sync/history/model/records";
import type {
	PushRecord,
	StoredRecord,
} from "@/features/sync/history/model/types";
import type { EFileKind, ManifestEntry } from "@/features/sync/types";

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 27, 10, 0, 0);

function entry(hash: string): ManifestEntry {
	return { hash, size: 1, mtime: 1, kind: "vault" as EFileKind };
}

/** Push n edits `note.md` from v(n-1) to vn, so a merge is easy to read. */
function pushes(
	times: readonly number[],
	parentOfFirst: string | null = null,
): StoredRecord[] {
	return times.map((at, index) =>
		storedRecord(
			{
				v: 1,
				vaultId: "v",
				id: `p${index + 1}`,
				parentId: index === 0 ? parentOfFirst : `p${index}`,
				createdAt: at,
				deviceId: "d",
				changes: {
					added: {},
					modified: {
						"note.md": { from: entry(`v${index}`), to: entry(`v${index + 1}`) },
					},
					deleted: {},
				},
			},
			at,
		),
	);
}

describe("storedRecord", () => {
	const push = (overrides: Partial<PushRecord>): PushRecord => ({
		v: 1,
		vaultId: "v",
		id: "p1",
		parentId: null,
		createdAt: BASE,
		deviceId: "d",
		changes: { added: {}, modified: {}, deleted: {} },
		...overrides,
	});

	it("counts no activity for a push of only the configuration folder", () => {
		expect(storedRecord(push({ released: ["R1"] }), BASE).activity).toEqual({});
	});

	it("still counts one push for an empty push that released nothing", () => {
		expect(storedRecord(push({}), BASE).activity).toEqual({
			[hourOf(BASE)]: [1, 0],
		});
	});

	it("counts a push that changed vault files even when it released versions", () => {
		const changed = push({
			changes: { added: { "a.md": entry("A") }, modified: {}, deleted: {} },
			released: ["R1"],
		});
		expect(storedRecord(changed, BASE).activity).toEqual({
			[hourOf(BASE)]: [1, 1],
		});
	});
});

describe("thin", () => {
	it("keeps every push at push resolution", () => {
		const records = pushes([BASE, BASE + MINUTE]);
		expect(thin(records, "push")).toEqual(records);
	});

	it("merges a contiguous run inside one span into its last push", () => {
		const records = pushes([
			BASE + MINUTE,
			BASE + 3 * MINUTE,
			BASE + 9 * MINUTE,
			BASE + 11 * MINUTE,
		]);
		const [first, second] = thin(records, "10m");
		expect(first).toMatchObject({
			id: "p3",
			parentId: null,
			at: BASE + 9 * MINUTE,
			firstAt: BASE + MINUTE,
			pushes: 3,
			activity: { [hourOf(BASE)]: [3, 3] },
		});
		expect(first?.changes.modified["note.md"]).toEqual({
			from: entry("v0"),
			to: entry("v3"),
		});
		expect(second).toBe(records[3]);
	});

	it("never merges across a gap in the chain", () => {
		const [first, second] = pushes([BASE + MINUTE, BASE + 2 * MINUTE]);
		const broken = [first, { ...second, parentId: "elsewhere" }];
		expect(thin(broken as StoredRecord[], "10m")).toHaveLength(2);
	});

	it("gives the same result thinned at once or step by step", () => {
		const times = Array.from({ length: 200 }, (_, i) => BASE + i * 7 * MINUTE);
		const records = pushes(times, "root");
		const direct = thin(records, "1d");
		const stepped = thin(thin(thin(records, "10m"), "1h"), "1d");
		expect(stepped).toEqual(direct);
	});
});
