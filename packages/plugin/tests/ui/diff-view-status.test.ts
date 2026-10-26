// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import type { CompareResult } from "@/sync/engine";
import { DiffView } from "@/ui/diff-view";
import { installElementMethods } from "../settings/setup/element-methods";

vi.mock("@/ui/diff/header", () => ({
	renderDiffFrame: vi.fn(),
	refitDiffTitle: vi.fn(),
}));
vi.mock("@/ui/common", () => ({
	notifyError: vi.fn(),
	redrawOnPhoneChange: vi.fn(),
}));
vi.mock("@/ui/modals", () => ({ openConfirmModal: vi.fn() }));
vi.mock("@/ui/source-control-view", () => ({ openSourceControlView: vi.fn() }));

beforeAll(installElementMethods);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Snapshot = { result: CompareResult | null; busy: boolean };
type Listener = (snapshot: Snapshot) => void;

async function open(fields: Record<string, unknown> = {}) {
	let listener: Listener = () => undefined;
	const getFileDiff = vi.fn(async () => null);
	const getHistoryDiff = vi.fn(async () => null);
	let result = { id: 1 } as unknown as CompareResult;
	const plugin = {
		controller: {
			subscribe: (fn: Listener) => {
				listener = fn;
				fn({ result, busy: false });
				return () => undefined;
			},
			getSnapshot: () => ({ result, busy: false }),
			fileDiffs: { getFileDiff },
			history: { getHistoryDiff },
		},
	};
	const leaf = { detach: vi.fn() };
	const view = new DiffView(leaf as never, plugin as unknown as PluginHost);
	const shown = { value: true };
	Object.assign(view, {
		contentEl: document.createElement("div"),
		containerEl: { isShown: () => shown.value },
		path: "a.md",
		...fields,
	});
	await view.onOpen();
	await settle();
	getFileDiff.mockClear();
	getHistoryDiff.mockClear();
	return {
		view,
		getFileDiff,
		getHistoryDiff,
		shown,
		compare: () => {
			result = { id: 2 } as unknown as CompareResult;
			listener({ result, busy: false });
		},
		progress: () => listener({ result, busy: true }),
		settleOperation: () => listener({ result, busy: false }),
	};
}

describe("DiffView status reloads", () => {
	it("ignores a broadcast that carries the same compare result", async () => {
		const { getFileDiff, progress } = await open();
		progress();
		await settle();
		expect(getFileDiff).not.toHaveBeenCalled();
	});

	it("reloads when a new compare result arrives", async () => {
		const { getFileDiff, compare } = await open();
		compare();
		await settle();
		expect(getFileDiff).toHaveBeenCalledTimes(1);
	});

	it("reloads when an operation ends without a new result", async () => {
		const { getFileDiff, progress, settleOperation } = await open();
		progress();
		settleOperation();
		await settle();
		expect(getFileDiff).toHaveBeenCalledTimes(1);
	});

	it("never reloads a comparison between two stored versions", async () => {
		const { getHistoryDiff, compare } = await open({
			historyHash: "h1",
			against: { hash: "h2", label: "Other" },
		});
		compare();
		await settle();
		expect(getHistoryDiff).not.toHaveBeenCalled();
	});

	it("marks a hidden view stale and reloads once when it is shown", async () => {
		const { view, getFileDiff, shown, compare } = await open();
		shown.value = false;
		compare();
		await settle();
		view.onResize();
		expect(getFileDiff).not.toHaveBeenCalled();

		shown.value = true;
		view.onResize();
		view.onResize();
		await settle();
		expect(getFileDiff).toHaveBeenCalledTimes(1);
	});
});
