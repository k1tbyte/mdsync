import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileExplorerRows } from "@/ui/explorer/file-explorer-api";
import { LinkScan } from "@/ui/explorer/link-scan";
import { createSymlinkDetector } from "@/vault/symlinks";

vi.mock("@/vault/symlinks", () => ({ createSymlinkDetector: vi.fn() }));

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
	frames.clear();
	vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
		frames.set(++nextFrame, run);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

function frame(): void {
	const ready = [...frames.values()];
	frames.clear();
	for (const run of ready) run(0);
}

function tree() {
	const paths = Array.from({ length: 200 }, (_, index) => `notes/${index}.md`);
	const linked = new Set([paths[0] as string]);
	const detector = {
		isLink: (path: string) => linked.has(path),
		findLink: vi.fn((path: string) => (linked.has(path) ? path : null)),
		invalidate: vi.fn(),
	};
	vi.mocked(createSymlinkDetector).mockReturnValue(detector);
	const host = {
		enabled: () => true,
		explorer: () => ({ paths: () => paths }) as FileExplorerRows,
		linksChanged: vi.fn(),
	};
	return { paths, linked, detector, scan: new LinkScan({} as never, host) };
}

describe("incremental explorer link scans", () => {
	it("keeps checked paths after a one-file change", () => {
		const { paths, detector, scan } = tree();
		scan.scan();
		for (let index = 0; index < 4; index++) frame();
		detector.findLink.mockClear();
		paths.push("notes/new.md");
		scan.invalidate("notes/new.md");
		scan.scan();
		frame();
		expect(detector.findLink).toHaveBeenCalledOnce();
		expect(detector.findLink).toHaveBeenCalledWith("notes/new.md");
		expect([...scan.links.keys()]).toEqual(["notes/0.md"]);
	});

	it("retains published links when a change interrupts a multi-frame scan", () => {
		const { paths, detector, scan } = tree();
		scan.scan();
		frame();
		expect(scan.links.has("notes/0.md")).toBe(true);
		paths.push("notes/new.md");
		scan.invalidate("notes/new.md");
		scan.scan();
		for (let index = 0; index < 3; index++) frame();
		expect(scan.links.has("notes/0.md")).toBe(true);
		expect(detector.findLink).toHaveBeenCalledTimes(201);
	});

	it("drops and rechecks the old and new subtrees of a rename", () => {
		const { paths, linked, detector, scan } = tree();
		scan.scan();
		for (let index = 0; index < 4; index++) frame();
		detector.findLink.mockClear();
		paths.splice(0, paths.length, "Moved/alias.md");
		linked.add("Moved/alias.md");
		scan.invalidate("notes");
		scan.invalidate("Moved");
		scan.scan();
		frame();
		expect([...scan.links.keys()]).toEqual(["Moved/alias.md"]);
		expect(detector.invalidate.mock.calls).toEqual([["notes"], ["Moved"]]);
		expect(detector.findLink).toHaveBeenCalledOnce();
	});
});
