import { describe, expect, it } from "vitest";
import { groupRows } from "@/ui/source-control/day-groups";

const NOON = new Date(2024, 4, 15, 12).getTime();
const DAY = 86_400_000;

function row(
	id: string,
	createdAt: number,
	pinned = false,
): { id: string; createdAt: number; pinned: boolean } {
	return { id, createdAt, pinned };
}

describe("groupRows", () => {
	it("keeps consecutive rows from one day together, in order", () => {
		const groups = groupRows(
			[
				row("a", NOON),
				row("b", NOON - 60_000),
				row("c", NOON - DAY),
				row("d", NOON - 3 * DAY),
			],
			NOON,
		);
		expect(groups.map((group) => group.label)).toEqual([
			"Today",
			"Yesterday",
			new Date(NOON - 3 * DAY).toLocaleDateString(undefined, {
				weekday: "long",
			}),
		]);
		expect(groups[0]?.rows.map((entry) => entry.id)).toEqual(["a", "b"]);
		expect(groups[1]?.rows.map((entry) => entry.id)).toEqual(["c"]);
	});

	it("opens a fresh group when a day repeats out of order", () => {
		const groups = groupRows(
			[row("a", NOON), row("b", NOON - DAY), row("c", NOON)],
			NOON,
		);
		expect(groups.map((group) => group.label)).toEqual([
			"Today",
			"Yesterday",
			"Today",
		]);
	});

	it("lifts pinned rows into a leading group, out of their day", () => {
		const groups = groupRows(
			[
				row("a", NOON),
				row("b", NOON - DAY, true),
				row("c", NOON - DAY),
				row("d", NOON - 3 * DAY, true),
			],
			NOON,
		);
		expect(groups.map((group) => group.label)).toEqual([
			"Pinned",
			"Today",
			"Yesterday",
		]);
		expect(groups[0]?.rows.map((entry) => entry.id)).toEqual(["b", "d"]);
		expect(groups[2]?.rows.map((entry) => entry.id)).toEqual(["c"]);
	});

	it("leaves no empty day behind when all its rows are pinned", () => {
		const groups = groupRows(
			[row("a", NOON), row("b", NOON - DAY, true)],
			NOON,
		);
		expect(groups.map((group) => group.label)).toEqual(["Pinned", "Today"]);
	});

	it("has no groups without rows", () => {
		expect(groupRows([], NOON)).toEqual([]);
	});
});
