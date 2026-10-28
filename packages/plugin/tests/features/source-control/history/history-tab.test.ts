// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryTab } from "@/features/source-control/history/history-tab";
import type { SourceControlHost } from "@/features/source-control/host";
import type { FileVersion } from "@/features/sync/history/types";
import type { EFileKind } from "@/features/sync/types";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	ButtonComponent: class {
		readonly buttonEl: HTMLButtonElement;
		disabled = false;
		constructor(parent: HTMLElement) {
			this.buttonEl = parent.createEl("button") as HTMLButtonElement;
		}
		setButtonText(text: string) {
			this.buttonEl.textContent = text;
			return this;
		}
		setDisabled(disabled: boolean) {
			this.disabled = disabled;
			this.buttonEl.disabled = disabled;
			return this;
		}
		onClick(fn: () => void) {
			this.buttonEl.addEventListener("click", fn);
			return this;
		}
	},
}));

installElementMethods();

const NOW = new Date(2026, 9, 28, 18, 0).getTime();
const HOUR = 3_600_000;
const ME = { id: "laptop", name: "Laptop" };

function version(index: number, pinned = false): FileVersion {
	const at = NOW - index * HOUR;
	return {
		snapshotId: `s${index}`,
		hash: `H${index}`,
		size: 10 + index,
		mtime: 1,
		kind: "vault" as EFileKind,
		createdAt: at,
		deviceId: "laptop",
		pinId: pinned ? `s${index}` : null,
		first: false,
		replayable: true,
		at,
		firstAt: at,
		pushes: 1,
		res: "push",
	};
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(results: FileVersion[][]) {
	const getFileHistory = vi.fn(async () => results.shift() as FileVersion[]);
	const plugin = {
		app: { workspace: { getActiveFile: () => null } },
		settings: { fileHistoryEnabled: true, fileHistoryKeep: "forever" },
		controller: {
			history: { getFileHistory },
			currentDevice: () => ME,
		},
	} as unknown as SourceControlHost;
	let pane!: HTMLElement;
	const draw = () => {
		// In the document, so focus moves as it does in Obsidian.
		pane = document.createElement("div");
		document.body.replaceChildren(pane);
		tab.render(pane, document.createElement("div"));
	};
	const tab = new HistoryTab(plugin, draw, vi.fn(), vi.fn(), vi.fn());
	tab.setPath("note.md");
	return { tab, draw, getFileHistory, pane: () => pane };
}

function pager(pane: HTMLElement) {
	const buttons = Array.from(
		pane.querySelectorAll<HTMLButtonElement>(
			".mdsync-history-row-actions button",
		),
	);
	return {
		meta: pane.querySelector(
			".mdsync-history-row-actions .mdsync-history-row-meta",
		)?.textContent,
		next: buttons.find((button) => button.textContent === "Next page"),
	};
}

describe("HistoryTab paging", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});

	it("renders 100 rows of 150 versions with the pager, and the next page the rest", async () => {
		const versions = Array.from({ length: 150 }, (_, index) => version(index));
		const { draw, pane } = harness([versions]);
		draw();
		await settled();

		expect(pane().querySelectorAll(".mdsync-history-row")).toHaveLength(100);
		expect(pager(pane()).meta).toBe("1-100 of 150");

		pager(pane()).next?.click();

		expect(pane().querySelectorAll(".mdsync-history-row")).toHaveLength(50);
		expect(pager(pane()).meta).toBe("101-150 of 150");
		// Next is disabled on the last page, so keyboard focus lands on Previous.
		expect(document.activeElement?.textContent).toBe("Previous page");
	});

	it("keeps a pinned version from deep in the list on page 1", async () => {
		const versions = Array.from({ length: 150 }, (_, index) =>
			version(index, index === 120),
		);
		const { draw, pane } = harness([versions]);
		draw();
		await settled();

		const rows = pane().querySelectorAll(".mdsync-history-row");
		expect(rows).toHaveLength(100);
		expect(rows[0]?.querySelector(".has-pin")).not.toBeNull();
		expect(pane().querySelectorAll(".has-pin")).toHaveLength(1);
	});

	it("starts over at page 1 on a new path", async () => {
		const versions = () =>
			Array.from({ length: 150 }, (_, index) => version(index));
		const { tab, draw, pane } = harness([versions(), versions()]);
		draw();
		await settled();
		pager(pane()).next?.click();

		tab.setPath("other.md");
		draw();
		await settled();

		expect(pane().querySelectorAll(".mdsync-history-row")).toHaveLength(100);
		expect(pager(pane()).meta).toBe("1-100 of 150");
	});

	it("shows no pager for a short list", async () => {
		const { draw, pane } = harness([
			Array.from({ length: 100 }, (_, index) => version(index)),
		]);
		draw();
		await settled();

		expect(pane().querySelectorAll(".mdsync-history-row")).toHaveLength(100);
		expect(pager(pane()).meta).toBeUndefined();
	});
});
