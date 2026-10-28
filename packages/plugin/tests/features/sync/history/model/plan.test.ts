import { DAY, HistorySim, HOUR, MINUTE } from "@tests/helpers/history-sim";
import { seeded } from "@tests/helpers/seeded";
import { describe, expect, it } from "vitest";
import { coverOf, type HistoryView } from "@/features/sync/history/model/cover";
import { groupStart } from "@/features/sync/history/model/periods";
import { freedHashes, planGc } from "@/features/sync/history/model/plan";
import { storedRecord } from "@/features/sync/history/model/records";
import type { HistoryObject } from "@/features/sync/history/model/types";
import type { EFileKind } from "@/features/sync/types";

/** The key of the object holding the record of `id`. */
function holder(sim: HistorySim, id: string): string | undefined {
	return [...sim.objects].find(([, { object }]) =>
		object.records.some((record) => record.id === id),
	)?.[0];
}

function expectSound(sim: HistorySim): void {
	const cover = sim.cover();
	expect(cover.lagging).toBe(false);
	expect(cover.truncated).toBe(false);
	sim.checkReplay(cover);
	expect(sim.countedPushes(cover)).toBe(sim.pushCount);
}

describe("history GC plan over a simulated vault", () => {
	it.each([0, 0.05])(
		"keeps every retained state replayable and every push counted, for 60 days of bursts (straggling %s)",
		(straggle) => {
			const sim = new HistorySim(11, 14 * DAY);
			sim.straggle = straggle;
			const random = seeded(5);
			const end = sim.now + 60 * DAY;
			let lastGc = sim.now;
			while (sim.now < end) {
				// A burst of instant saves, then a pause of minutes to hours.
				const burst = random() < 0.3 ? 40 : 3;
				for (let i = 0; i < burst; i++) {
					sim.push(sim.after(5_000 + Math.floor(random() * 20_000)));
				}
				sim.after(Math.floor(random() * 3 * HOUR));
				if (sim.now - lastGc >= 10 * MINUTE) {
					sim.gc(sim.now);
					lastGc = sim.now;
					expectSound(sim);
				}
			}
			const before = sim.objects.size + sim.pushes.size;
			expect(sim.gc(sim.now)).toBe(0);
			expect(sim.objects.size + sim.pushes.size).toBe(before);
			// Thinned: a few dozen objects for 60 days of pushes, the oldest down to counts.
			expect(sim.objects.size).toBeLessThan(80);
			const resolutions = [...sim.objects.values()].map(
				({ object }) => object.res,
			);
			expect(resolutions).toContain("counts");
			expect(resolutions).toContain("1d");
			expect(sim.pushCount).toBeGreaterThan(1000);
		},
	);

	it("keeps history forever when there is no horizon, thinned to weeks", () => {
		const sim = new HistorySim(2, null);
		for (let day = 0; day < 120; day++) {
			for (let i = 0; i < 6; i++) sim.push(sim.after(HOUR));
			sim.gc(sim.after(18 * HOUR));
		}
		expectSound(sim);
		const resolutions = [...sim.objects.values()].map(
			({ object }) => object.res,
		);
		expect(resolutions).not.toContain("counts");
		expect(resolutions).toContain("1w");
	});

	it("rebuilds a slot when a record written before its publish joins the chain late", () => {
		const sim = new HistorySim(3, 14 * DAY);
		for (let i = 0; i < 5; i++) sim.push(sim.after(MINUTE));
		const late = sim.push(sim.after(MINUTE), false);
		sim.gc(sim.after(HOUR));
		expectSound(sim);
		expect(sim.pushes.has(`p/${late.snapshotId}`)).toBe(true);
		sim.publish(late);
		sim.gc(sim.after(10 * MINUTE));
		expectSound(sim);
		expect(sim.pushes.size).toBe(0);
	});

	it("deletes a push that lost the guard once it is settled, and not before", () => {
		const sim = new HistorySim(4, 14 * DAY);
		sim.push(sim.after(MINUTE));
		const lost = sim.push(sim.after(MINUTE), false);
		// Another device published on the same parent: the lost push can never join.
		sim.push(sim.after(MINUTE));
		sim.gc(sim.after(HOUR));
		expect(sim.pushes.has(`p/${lost.snapshotId}`)).toBe(true);
		sim.gc(sim.after(DAY));
		expect(sim.pushes.has(`p/${lost.snapshotId}`)).toBe(false);
		expectSound(sim);
	});

	it("builds nothing over a group the walk has not reached the start of", () => {
		const sim = new HistorySim(6, 14 * DAY);
		const first = groupStart("push", sim.now + MINUTE);
		for (let i = 0; i < 20; i++) sim.push(sim.after(MINUTE));
		// The first record is gone: the walk stops inside the slot it opened.
		sim.pushes.delete("p/s1");
		const plan = planGc({
			view: sim.view(),
			cover: sim.cover(),
			vaultId: "vault",
			now: sim.after(HOUR),
			horizon: 14 * DAY,
			settledBefore: sim.now - DAY,
		});
		expect(plan.builds.some((build) => build.group === first)).toBe(false);
		expect(plan.builds.length).toBeGreaterThan(0);
	});
});

describe("freedHashes", () => {
	const entry = (hash: string) => ({
		hash,
		size: 1,
		mtime: 1,
		kind: "vault" as EFileKind,
	});
	const changes = (hash: string) => ({
		added: { "a.md": entry(hash) },
		modified: {},
		deleted: {},
	});

	it("frees what a replaced record released, and not what a kept record names", () => {
		const freed = freedHashes(
			[{ changes: changes("A"), released: ["R1", "R2"] }],
			[{ changes: changes("R2") }],
		);
		expect([...freed].sort()).toEqual(["A", "R1"]);
	});

	it("frees only what a record names without a released list", () => {
		expect([...freedHashes([{ changes: changes("A") }], [])]).toEqual(["A"]);
	});
});

describe("history GC plan, races", () => {
	it("keeps a straggler's record on the walk while its neighbours pack", () => {
		const sim = new HistorySim(7, null);
		const t0 = sim.now;
		for (let i = 1; i <= 5; i++) sim.push(t0 + i * MINUTE);
		// s3's storage clock ran ahead of its successors'.
		const s3 = sim.pushes.get("p/s3");
		if (s3) s3.at = t0 + 30 * MINUTE;
		for (const now of [t0 + 25 * MINUTE, t0 + 2 * HOUR, t0 + 9 * DAY]) {
			sim.gc(now);
			expectSound(sim);
		}
	});

	it("keeps a sibling that held HEAD for a moment until the horizon", () => {
		const sim = new HistorySim(8, 14 * DAY);
		const t0 = sim.now;
		sim.push(t0 + MINUTE);
		const parent = sim.push(t0 + 2 * MINUTE);
		sim.push(t0 + 12 * MINUTE);
		sim.gc(t0 + 31 * MINUTE);
		const sibling = holder(sim, "s3");
		// A push that passed its precheck on the same parent lands over s3.
		sim.head = parent;
		sim.push(t0 + 15 * MINUTE);
		for (const now of [t0 + 40 * MINUTE, t0 + 2 * DAY]) {
			sim.gc(now);
			expect(holder(sim, "s3")).toBe(sibling);
			expect(sim.cover().truncated).toBe(false);
			sim.checkReplay(sim.cover());
		}
		sim.gc(t0 + 60 * DAY);
		expect(holder(sim, "s3")).toBeUndefined();
	});

	it("leaves a packed record behind a gap alone when a straggler after the gap looks older", () => {
		const sim = new HistorySim(9, null);
		const t0 = sim.now;
		sim.push(t0 + 61 * MINUTE);
		sim.gc(t0 + 81 * MINUTE);
		sim.push(t0 + 82 * MINUTE);
		// s2's record never landed: a gap.
		sim.pushes.delete("p/s2");
		sim.push(t0 + 83 * MINUTE);
		sim.push(t0 + 84 * MINUTE);
		const s3 = sim.pushes.get("p/s3");
		const s4 = sim.pushes.get("p/s4");
		if (!s3 || !s4) throw new Error("no record");
		s3.at = t0 + 49 * MINUTE;
		s4.at = t0 + 62 * MINUTE;
		sim.push(t0 + DAY);
		sim.gc(t0 + DAY + HOUR);
		expect(holder(sim, "s1")).toBeDefined();
	});

	it("keeps a record whose successor straggles back over a four-week boundary", () => {
		const boundary = groupStart("counts", Date.UTC(2026, 6, 1)) + 28 * DAY;
		const sim = new HistorySim(10, 7 * DAY, boundary - 10 * MINUTE);
		sim.push(boundary - 2 * MINUTE);
		sim.push(boundary + MINUTE);
		sim.push(boundary + 2 * MINUTE);
		const s3 = sim.pushes.get("p/s3");
		if (!s3) throw new Error("no record");
		s3.at = boundary - MINUTE;
		sim.push(boundary + 7 * DAY + MINUTE);
		sim.gc(boundary + 7 * DAY + 2 * MINUTE);
		const cover = sim.cover();
		// s3 moves up to s2's time, so the hour keeps them as one record reaching back to the counted s1.
		expect(
			cover.chain.map(({ record }) => [record.id, record.parentId]),
		).toEqual([
			["s4", "s3"],
			["s3", "s1"],
		]);
		expect(cover.truncated).toBe(false);
		sim.checkReplay(cover);
	});

	it("merges a later view into a group's counts instead of adding it", () => {
		const at = Date.UTC(2026, 0, 6, 10);
		const record = storedRecord(
			{
				v: 1,
				vaultId: "vault",
				id: "a",
				parentId: null,
				createdAt: at,
				deviceId: "d",
				changes: { added: {}, modified: {}, deleted: {} },
			},
			at,
		);
		const group = groupStart("counts", at);
		const object = (res: HistoryObject["res"]): HistoryObject => ({
			v: 1,
			vaultId: "vault",
			res,
			group,
			records: res === "counts" ? [] : [record],
			consumed: [],
		});
		const view: HistoryView = {
			pushes: new Map(),
			objects: new Map([
				["b/week", { object: object("1w"), at }],
				[
					"b/counts",
					{
						object: {
							...object("counts"),
							activity: record.activity,
							lastId: "a",
						},
						at,
					},
				],
			]),
		};
		const now = at + 120 * DAY;
		const plan = planGc({
			view,
			cover: coverOf(view, { id: "a", parentId: null, vaultId: "vault" }),
			vaultId: "vault",
			now,
			horizon: 14 * DAY,
			settledBefore: now - DAY,
		});
		expect(plan.builds).toEqual([
			{
				vaultId: "vault",
				res: "counts",
				group,
				records: [],
				activity: record.activity,
				lastId: "a",
				consumed: ["b/counts", "b/week"],
			},
		]);
	});
});
