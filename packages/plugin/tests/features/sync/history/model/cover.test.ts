import { HistorySim, MINUTE } from "@tests/helpers/history-sim";
import { describe, expect, it } from "vitest";
import { coverOf } from "@/features/sync/history/model/cover";
import { storedRecord, thin } from "@/features/sync/history/model/records";
import type { HistoryObject } from "@/features/sync/history/model/types";

const START = Date.UTC(2026, 6, 1, 8, 0, 0);

function vaultOf(pushes: number): HistorySim {
	const sim = new HistorySim(1, null);
	for (let i = 1; i <= pushes; i++) sim.push(START + i * MINUTE);
	return sim;
}

function headOf(sim: HistorySim) {
	const head = sim.head;
	if (!head) throw new Error("no head");
	return {
		id: head.snapshotId,
		parentId: head.parentSnapshotId,
		vaultId: head.vaultId,
	};
}

/** An object over the given push keys, as GC would write it. */
function objectOf(
	sim: HistorySim,
	keys: string[],
	res: HistoryObject["res"],
): HistoryObject {
	const records = keys.map((key) => {
		const pushed = sim.pushes.get(key);
		if (!pushed) throw new Error(key);
		return storedRecord(pushed.push, pushed.at);
	});
	return {
		v: 1,
		vaultId: "vault",
		res,
		group: 0,
		records: thin(records, res),
		consumed: keys,
	};
}

describe("coverOf", () => {
	it("walks every push from HEAD back to the first", () => {
		const sim = vaultOf(4);
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.record.id)).toEqual([
			"s4",
			"s3",
			"s2",
			"s1",
		]);
		expect(cover).toMatchObject({ lagging: false, truncated: false });
	});

	it("starts at HEAD's parent while HEAD's record is not listed yet", () => {
		const sim = vaultOf(3);
		sim.pushes.delete("p/s3");
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.record.id)).toEqual(["s2", "s1"]);
		expect(cover.lagging).toBe(true);
	});

	it("stops at a missing record and says so", () => {
		const sim = vaultOf(4);
		sim.pushes.delete("p/s2");
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.record.id)).toEqual(["s4", "s3"]);
		expect(cover.truncated).toBe(true);
	});

	it("reads an object instead of the pushes it replaced", () => {
		const sim = vaultOf(4);
		sim.objects.set("b/1", {
			object: objectOf(sim, ["p/s1", "p/s2", "p/s3"], "10m"),
			at: START + 60 * MINUTE,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(
			cover.chain.map((walked) => [walked.record.id, walked.source]),
		).toEqual([
			["s4", "p/s4"],
			["s3", "b/1"],
		]);
		expect(cover.consumed).toEqual(new Set(["p/s1", "p/s2", "p/s3"]));
	});

	it("prefers the coarser of two objects covering the same pushes", () => {
		const sim = vaultOf(4);
		const coarse = objectOf(sim, ["p/s2", "p/s3"], "1h");
		sim.objects.set("b/coarse", {
			object: { ...coarse, consumed: [] },
			at: START,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.source)).toEqual([
			"p/s4",
			"b/coarse",
			"p/s1",
		]);
	});

	it("takes the path that reaches the first push over a coarser one that dead-ends", () => {
		const sim = vaultOf(4);
		const coarse = objectOf(sim, ["p/s3"], "1h");
		const [record] = coarse.records;
		if (!record) throw new Error("no record");
		sim.objects.set("b/coarse", {
			object: {
				...coarse,
				records: [{ ...record, parentId: "ghost" }],
				consumed: [],
			},
			at: START,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.source)).toEqual([
			"p/s4",
			"p/s3",
			"p/s2",
			"p/s1",
		]);
		expect(cover.truncated).toBe(false);
	});

	it("walks an object holding a straggler's runs by their parent links", () => {
		const sim = vaultOf(3);
		sim.objects.set("b/a", {
			object: objectOf(sim, ["p/s1", "p/s3"], "push"),
			at: START + 60 * MINUTE,
		});
		sim.objects.set("b/b", {
			object: objectOf(sim, ["p/s2"], "push"),
			at: START + 60 * MINUTE,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(
			cover.chain.map((walked) => [walked.record.id, walked.source]),
		).toEqual([
			["s3", "b/a"],
			["s2", "b/b"],
			["s1", "b/a"],
		]);
		expect(cover.truncated).toBe(false);
		sim.checkReplay(cover);
	});

	it("forks from inside a packed run when a delayed sibling wins", () => {
		const sim = vaultOf(2);
		sim.objects.set("b/run", {
			object: objectOf(sim, ["p/s1", "p/s2"], "push"),
			at: START + 60 * MINUTE,
		});
		const first = sim.manifests.get("s1");
		if (!first) throw new Error("no s1");
		sim.head = first;
		sim.push(START + 61 * MINUTE);
		const cover = coverOf(sim.view(), headOf(sim));
		expect(
			cover.chain.map((walked) => [walked.record.id, walked.source]),
		).toEqual([
			["s3", "p/s3"],
			["s1", "b/run"],
		]);
		expect(cover.truncated).toBe(false);
		sim.checkReplay(cover);
	});

	it("lets only the later of two objects naming each other replace the other", () => {
		const sim = vaultOf(2);
		const object = objectOf(sim, ["p/s1", "p/s2"], "10m");
		sim.objects.set("b/old", {
			object: { ...object, consumed: ["b/new"] },
			at: START,
		});
		sim.objects.set("b/new", {
			object: { ...object, consumed: ["b/old"] },
			at: START + MINUTE,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.consumed.has("b/old")).toBe(true);
		expect(cover.consumed.has("b/new")).toBe(false);
	});

	it("ignores another vault's records and survives a cycle in corrupt data", () => {
		const sim = vaultOf(2);
		const s1 = sim.pushes.get("p/s1");
		if (!s1) throw new Error("no s1");
		sim.pushes.set("p/s1", { ...s1, push: { ...s1.push, parentId: "s2" } });
		sim.pushes.set("p/x", {
			push: { ...s1.push, id: "x", vaultId: "other" },
			at: START,
		});
		const cover = coverOf(sim.view(), headOf(sim));
		expect(cover.chain.map((walked) => walked.record.id)).toEqual(["s2", "s1"]);
		expect(cover.truncated).toBe(true);
	});
});
