import { describe, expect, it } from "vitest";

import { RowPager } from "@/ui/source-control/row-pager";

const rows = Array.from({ length: 20_001 }, (_, index) => index);

describe("history row paging", () => {
	it("bounds a large snapshot to 100 rendered file rows", () => {
		const pager = new RowPager();
		expect(pager.slice(rows)).toEqual(rows.slice(0, 100));
		pager.move(1, rows.length);
		expect(pager.slice(rows)).toEqual(rows.slice(100, 200));
		pager.move(1_000, rows.length);
		expect(pager.slice(rows)).toEqual([20_000]);
		pager.move(-1_000, rows.length);
		expect(pager.slice(rows)).toEqual(rows.slice(0, 100));
	});

	it("clamps the page after files disappear", () => {
		const pager = new RowPager();
		pager.move(10, rows.length);
		expect(pager.slice(rows.slice(0, 101))).toEqual([100]);
		expect(pager.slice([])).toEqual([]);
		expect(pager.slice(rows)).toEqual(rows.slice(0, 100));
	});

	it("does not mutate or discard the rows used for bulk selection", () => {
		const pager = new RowPager();
		const all = [...rows];
		pager.move(5, all.length);
		pager.slice(all);
		expect(all).toEqual(rows);
	});
});
