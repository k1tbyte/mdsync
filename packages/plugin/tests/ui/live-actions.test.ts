import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { notifyInfo } from "@/ui/common/notices";
import { rebuildLiveNote, toggleAuthors } from "@/ui/live/header/live-actions";

vi.mock("@/ui/common/notices", () => ({
	notifyInfo: vi.fn(),
	reportError: vi.fn(),
}));

const plugin = (live: object): PluginHost =>
	({
		realtime: { live },
		settings: { showLiveAuthors: false },
		saveSettings: vi.fn(async () => {}),
	}) as unknown as PluginHost;

beforeEach(() => vi.mocked(notifyInfo).mockClear());

describe("live note actions", () => {
	it("remembers whether authors are tinted and repaints on each toggle", () => {
		const repaintAuthors = vi.fn();
		const host = plugin({ repaintAuthors });
		toggleAuthors(host);
		expect(host.settings.showLiveAuthors).toBe(true);
		toggleAuthors(host);
		expect(host.settings.showLiveAuthors).toBe(false);
		expect(repaintAuthors).toHaveBeenCalledTimes(2);
		expect(host.saveSettings).toHaveBeenCalledTimes(2);
		expect(vi.mocked(notifyInfo).mock.calls).toEqual([
			["Text others typed in live notes is tinted by author."],
			["Authors hidden."],
		]);
	});

	it("tells how a rebuild ended", async () => {
		const host = plugin({ rotate: async () => "busy" });
		rebuildLiveNote(host, "Team/a.md");
		await vi.waitFor(() =>
			expect(notifyInfo).toHaveBeenCalledWith(
				"Still sending edits. Try again in a moment.",
			),
		);
	});
});
