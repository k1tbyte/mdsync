import { FakeEl } from "@tests/helpers/fake-dom";
import type { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { registerLiveStatusBar } from "@/ui/live/live-status-bar";
import { openWhereMenu } from "@/ui/live/where-menu";

vi.mock("@/ui/live/where-menu", () => ({ openWhereMenu: vi.fn() }));

function setup() {
	const root = new FakeEl("div");
	const plugin = {
		addStatusBarItem: () => root,
		register: vi.fn(),
		spaces: { partition: () => [] },
		realtime: { statusOf: () => "off", people: { subscribe: () => () => {} } },
	} as unknown as Plugin & PluginHost;
	registerLiveStatusBar(plugin);
	return { root, plugin };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(openWhereMenu).mockClear();
});

afterEach(() => vi.useRealTimers());

describe("the live status bar item", () => {
	it("is a button a keyboard reaches", () => {
		const { root } = setup();

		expect(root.attrs.get("role")).toBe("button");
		expect(root.attrs.get("tabindex")).toBe("0");
	});

	it("opens the status menu from itself on click", () => {
		const { root, plugin } = setup();

		root.fire("click");

		expect(openWhereMenu).toHaveBeenCalledWith(plugin, root);
	});

	it.each(["Enter", " "])("opens it on %j", (key) => {
		const { root, plugin } = setup();

		root.fire("keydown", { key, target: root });

		expect(openWhereMenu).toHaveBeenCalledWith(plugin, root);
	});

	it("does not open it on other keys", () => {
		const { root } = setup();

		root.fire("keydown", { key: "Tab", target: root });

		expect(openWhereMenu).not.toHaveBeenCalled();
	});
});
