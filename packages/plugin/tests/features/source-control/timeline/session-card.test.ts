// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { describe, expect, it, vi } from "vitest";
import { RowPager } from "@/features/source-control/history/row-pager";
import {
	type CardContext,
	renderSessionCard,
} from "@/features/source-control/timeline/session-card";
import { buildSessionRows } from "@/features/source-control/timeline/session-rows";
import type { SnapshotSummary } from "@/features/sync";
import type { EFileKind } from "@/features/sync/types";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	ButtonComponent: (await import("@tests/helpers/button-component"))
		.DomButtonComponent,
}));

installElementMethods();

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const MINUTE = 60_000;

/** A minute apart, all on one path: one session whose files stay under a page of their own. */
function pushes(count: number, res: SnapshotSummary["res"]): SnapshotSummary[] {
	return Array.from({ length: count }, (_, index) => {
		const at = NOW - 2 * 60 * MINUTE - index * MINUTE;
		return {
			id: `s${index}`,
			createdAt: at,
			deviceId: "laptop",
			pinned: false,
			files: {
				added: {
					"a.md": {
						hash: `h${index}`,
						size: 1,
						mtime: 1,
						kind: "vault" as EFileKind,
					},
				},
				modified: {},
				deleted: {},
			},
			keptUntil: null,
			restorable: true,
			isHead: false,
			at,
			firstAt: at,
			pushes: 1,
			res,
		};
	});
}

function draw(count: number, res: SnapshotSummary["res"]) {
	const [row] = buildSessionRows(pushes(count, res), { now: NOW });
	if (!row) throw new Error("no session");
	const pagers = new Map<string, RowPager>();
	const parent = document.createElement("div");
	const render = () => {
		parent.replaceChildren();
		renderSessionCard(parent, row, ctx);
	};
	const ctx = {
		query: "",
		selected: null,
		opening: null,
		isOpen: (key: string) => key === row.key || key === `all:${row.key}`,
		toggle: vi.fn(),
		pager: (key: string) => {
			let pager = pagers.get(key);
			if (!pager) {
				pager = new RowPager();
				pagers.set(key, pager);
			}
			return pager;
		},
		rerender: render,
	} as unknown as CardContext;
	render();
	return {
		parent,
		versions: () =>
			parent.querySelectorAll(
				".mdsync-timeline-files > .mdsync-timeline-version",
			),
		meta: () =>
			parent.querySelector(
				".mdsync-timeline-files > .mdsync-history-row-actions .mdsync-history-row-meta",
			)?.textContent,
		next: () =>
			Array.from(parent.querySelectorAll("button")).find(
				(button) => button.textContent === "Next page",
			),
	};
}

describe("renderSessionCard versions", () => {
	it.each([
		["every push", "push"],
		["a packed period", "10m"],
	] as const)(
		"renders 100 of 150 versions with the pager for %s, and the next page the rest",
		(_, res) => {
			const card = draw(150, res);

			expect(card.versions()).toHaveLength(100);
			expect(card.meta()).toBe("1-100 of 150");

			card.next()?.click();

			expect(card.versions()).toHaveLength(50);
			expect(card.meta()).toBe("101-150 of 150");
		},
	);

	it("shows no pager for a short session", () => {
		const card = draw(100, "push");

		expect(card.versions()).toHaveLength(100);
		expect(card.meta()).toBeUndefined();
	});
});
