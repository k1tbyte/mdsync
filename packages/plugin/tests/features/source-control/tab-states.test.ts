// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { describe, expect, it, vi } from "vitest";
import type { SettingsHost } from "@/core/settings";
import { renderHistoryOff } from "@/features/source-control/tab-states";

installElementMethods();

describe("renderHistoryOff", () => {
	it("turns history on, saves, then redraws", async () => {
		const order: string[] = [];
		const plugin = {
			settings: { fileHistoryEnabled: false },
			saveSettings: vi.fn(async () => {
				order.push(`saved ${plugin.settings.fileHistoryEnabled}`);
			}),
			scheduleScopeRefresh: vi.fn(),
		} as unknown as SettingsHost;
		const parent = document.createElement("div");
		const redraw = vi.fn(() => order.push("redrawn"));

		renderHistoryOff(parent, plugin, "Keep past versions.", redraw);
		const button = parent.querySelector("button");
		expect(button?.textContent).toBe("Turn on history");
		button?.click();
		await vi.waitFor(() => expect(redraw).toHaveBeenCalledOnce());

		expect(order).toEqual(["saved true", "redrawn"]);
	});
});
