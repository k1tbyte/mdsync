import type { Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { registerCommands } from "@/commands";
import type { PluginHost } from "@/plugin/host";
import { openWhereMenu } from "@/ui";

vi.mock("@/ui", () => ({ openWhereMenu: vi.fn() }));

interface Registered {
	id: string;
	name: string;
	callback?: () => void;
}

function register() {
	const commands: Registered[] = [];
	const plugin = {
		addCommand: (command: Registered) => commands.push(command),
	} as unknown as Plugin & PluginHost;
	registerCommands(plugin);
	return { plugin, commands };
}

describe("the plugin's commands", () => {
	it("each have their own id", () => {
		const { commands } = register();

		expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
	});

	it("open the live status menu from the palette, with no anchor", () => {
		const { plugin, commands } = register();
		const command = commands.find(({ id }) => id === "show-live-status");

		expect(command?.name).toBe("Show live status");
		command?.callback?.();

		expect(openWhereMenu).toHaveBeenCalledWith(plugin);
	});
});
