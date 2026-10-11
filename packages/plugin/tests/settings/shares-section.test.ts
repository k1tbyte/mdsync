import type { SettingDefinitionPage } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { FieldContext } from "@/settings/fields";
import { sharesSection } from "@/settings/sections/shares";

vi.mock("@/settings/page", () => ({ imperativePage: vi.fn() }));
vi.mock("@/ui", () => ({
	openInvite: vi.fn(),
	openShareWindow: vi.fn(),
	shareSummary: vi.fn(),
}));

function form() {
	const settings = { useSharedFolders: true };
	const records: { closed?: true; access: { kind: string } }[] = [];
	const ctx = {
		plugin: { settings, spaces: { list: () => records } },
		rerender: vi.fn(),
	} as unknown as FieldContext;
	const entry = sharesSection(ctx).items?.find(
		(item) => item.name === "Your shared folders",
	) as SettingDefinitionPage;
	return { settings, records, entry };
}

describe("the shared folders page entry", () => {
	it("is visible only with enabled, open shares", () => {
		const { settings, records, entry } = form();
		if (typeof entry.visible !== "function")
			throw new Error("Missing visibility predicate");
		expect(entry.visible()).toBe(false);
		const owner: (typeof records)[number] = { access: { kind: "owner" } };
		records.push(owner);
		expect(entry.visible()).toBe(true);
		settings.useSharedFolders = false;
		expect(entry.visible()).toBe(false);
		settings.useSharedFolders = true;
		owner.closed = true;
		expect(entry.visible()).toBe(false);
	});

	it("counts current open shares without rebuilding definitions", () => {
		const { records, entry } = form();
		if (typeof entry.displayValue !== "function")
			throw new Error("Missing count callback");
		expect(entry.displayValue()).toBe("0");
		const owner: (typeof records)[number] = { access: { kind: "owner" } };
		records.push(
			owner,
			{ access: { kind: "participant" } },
			{ closed: true, access: { kind: "owner" } },
		);
		expect(entry.displayValue()).toBe("2");
		owner.closed = true;
		expect(entry.displayValue()).toBe("1");
	});
});
