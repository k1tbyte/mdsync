import type { DataAdapter } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileExplorerRows } from "@/ui/explorer/file-explorer-api";
import { LinkScan } from "@/ui/explorer/link-scan";
import { createSymlinkDetector } from "@/vault/symlinks";

vi.mock("@/vault/symlinks", () => ({ createSymlinkDetector: vi.fn() }));

const LINKS = new Set(["f3", "f70"]);

function setup(count = 130) {
	let enabled = true;
	let rows = true;
	let paths = Array.from({ length: count }, (_, i) => `f${i}`);
	const findLink = vi.fn((path: string) => (LINKS.has(path) ? path : null));
	vi.mocked(createSymlinkDetector).mockImplementation(() => ({
		isLink: () => false,
		findLink,
	}));
	const linksChanged = vi.fn();
	const scan = new LinkScan({} as DataAdapter, {
		enabled: () => enabled,
		explorer: () =>
			rows ? ({ paths: () => paths } as unknown as FileExplorerRows) : null,
		linksChanged,
	});
	return {
		scan,
		findLink,
		linksChanged,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
		setRows: (value: boolean) => {
			rows = value;
		},
		setPaths: (next: string[]) => {
			paths = next;
		},
	};
}

const frame = (): void => {
	vi.advanceTimersByTime(20);
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(createSymlinkDetector).mockReset();
});

afterEach(() => vi.useRealTimers());

describe("the tree's link scan", () => {
	it("checks a batch of paths per frame and reports once at the end", () => {
		const { scan, findLink, linksChanged } = setup();

		scan.scan();
		frame();
		expect(findLink).toHaveBeenCalledTimes(64);
		frame();
		expect(findLink).toHaveBeenCalledTimes(128);
		expect(linksChanged).not.toHaveBeenCalled();
		frame();

		expect(findLink).toHaveBeenCalledTimes(130);
		expect(linksChanged).toHaveBeenCalledTimes(1);
		expect([...scan.links.keys()]).toEqual(["f3", "f70"]);
	});

	it("stops the scan in flight when reset, and forgets what it found", () => {
		const { scan, findLink, linksChanged } = setup();
		scan.scan();
		frame();

		scan.reset();
		frame();
		frame();

		expect(findLink).toHaveBeenCalledTimes(64);
		expect(linksChanged).not.toHaveBeenCalled();
		expect(scan.links.size).toBe(0);
	});

	it("does not check a path twice, and drops links whose row is gone", () => {
		const { scan, findLink, setPaths } = setup(10);
		scan.scan();
		frame();
		findLink.mockClear();

		setPaths(["f1", "f2", "f10"]);
		scan.scan();
		frame();

		expect(findLink.mock.calls).toEqual([["f10"]]);
		expect(scan.links.size).toBe(0);
	});

	it("runs once more after a scan that was asked for while it was running", () => {
		const { scan, findLink, setPaths } = setup(70);
		scan.scan();
		frame();
		setPaths([...Array.from({ length: 70 }, (_, i) => `f${i}`), "late"]);
		scan.scan();
		findLink.mockClear();

		frame();
		frame();

		const checked = findLink.mock.calls.map(([path]) => path);
		expect(checked).toEqual([
			...Array.from({ length: 6 }, (_, i) => `f${64 + i}`),
			"late",
		]);
	});

	it("starts over when the setting flips, and finds nothing while off", () => {
		const { scan, findLink, setEnabled } = setup(10);
		expect(scan.followSetting()).toBe(false);
		scan.scan();
		frame();
		expect(scan.links.size).toBe(1);

		setEnabled(false);
		expect(scan.followSetting()).toBe(true);
		findLink.mockClear();
		scan.scan();
		frame();

		expect(vi.mocked(createSymlinkDetector)).toHaveBeenLastCalledWith(
			expect.anything(),
			false,
		);
		expect(findLink).not.toHaveBeenCalled();
		expect(scan.links.size).toBe(0);
		expect(scan.followSetting()).toBe(false);
	});

	it("stops scanning when stopped, and reports nothing after", () => {
		const { scan, findLink, linksChanged } = setup();
		scan.scan();
		frame();

		scan.stop();
		frame();
		frame();
		frame();

		expect(findLink).toHaveBeenCalledTimes(64);
		expect(linksChanged).not.toHaveBeenCalled();
	});

	it("has nothing to scan while the explorer has no rows", () => {
		const { scan, findLink, linksChanged, setRows } = setup();
		setRows(false);

		scan.scan();
		frame();

		expect(findLink).not.toHaveBeenCalled();
		expect(linksChanged).not.toHaveBeenCalled();
		expect(scan.links.size).toBe(0);
	});

	it("skips a path with no name", () => {
		const { scan, findLink, setPaths } = setup();
		setPaths(["", "f3"]);

		scan.scan();
		frame();

		expect(findLink.mock.calls).toEqual([["f3"]]);
	});

	it("drops the scan in flight when the setting flips, finding nothing after", () => {
		const { scan, findLink, linksChanged, setEnabled } = setup();
		scan.scan();
		frame();

		setEnabled(false);
		expect(scan.followSetting()).toBe(true);
		frame();
		frame();
		frame();

		expect(findLink).toHaveBeenCalledTimes(64);
		expect(linksChanged).not.toHaveBeenCalled();
		expect(scan.links.size).toBe(0);
	});
});
