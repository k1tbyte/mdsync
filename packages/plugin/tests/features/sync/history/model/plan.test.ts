import { DAY, HistorySim, HOUR, MINUTE } from "@tests/helpers/history-sim";
import { seeded } from "@tests/helpers/seeded";
import { describe, expect, it } from "vitest";
import { groupStart } from "@/features/sync/history/model/periods";
import { planGc } from "@/features/sync/history/model/plan";

function expectSound(sim: HistorySim): void {
	const cover = sim.cover();
	expect(cover.lagging).toBe(false);
	expect(cover.truncated).toBe(false);
	sim.checkReplay(cover);
	expect(sim.countedPushes(cover)).toBe(sim.pushCount);
}

describe("history GC plan over a simulated vault", () => {
	it("keeps every retained state replayable and every push counted, for 60 days of bursts", () => {
		const sim = new HistorySim(11, 14 * DAY);
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
	});

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
