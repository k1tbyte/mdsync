import type { Setting, SettingDefinitionRender } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
	type FieldContext,
	fieldRow,
	group,
	introRow,
	renderDefinitions,
	type SettingsRow,
} from "@/settings/fields";
import { EFieldKind } from "@/storage/field-spec";

vi.mock("obsidian", () => ({
	debounce: (fn: unknown) => fn,
	Setting: class {
		name = "";
		desc = "";
		heading = false;
		constructor() {
			rows.push(this);
		}
		setName(name: string) {
			this.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.desc = desc;
			return this;
		}
		setHeading() {
			this.heading = true;
			return this;
		}
	},
}));

const rows: { name: string; desc: string; heading: boolean }[] = [];

describe("setting definitions", () => {
	it("evaluates field visibility against current settings", () => {
		const settings = { realtimeSync: false };
		const ctx = {
			plugin: { settings },
			rerender: vi.fn(),
		} as unknown as FieldContext;
		const row: SettingDefinitionRender = fieldRow(ctx, {
			kind: EFieldKind.Toggle,
			name: "Live editing",
			when: (s) => s.realtimeSync,
			get: (s) => s.liveEditing,
			set: (value) => ({ liveEditing: value }),
		});
		if (typeof row.visible !== "function")
			throw new Error("Missing visibility predicate");
		expect(row.visible()).toBe(false);
		settings.realtimeSync = true;
		expect(row.visible()).toBe(true);
	});

	it("renders group headings, names and descriptions, skipping invisible rows", () => {
		rows.length = 0;
		const render = vi.fn();
		const hidden = vi.fn();
		const items: SettingsRow[] = [
			{ name: "Shown", desc: "Description", render },
			{ name: "Hidden", visible: false, render: hidden },
			{ name: "Conditional", visible: () => false, render: hidden },
			introRow("Introduction"),
		];
		renderDefinitions({} as HTMLElement, [group("Heading", items)]);
		expect(rows).toEqual([
			{ name: "Heading", desc: "", heading: true },
			{ name: "Shown", desc: "Description", heading: false },
			{ name: "", desc: "Introduction", heading: false },
		]);
		expect(render).toHaveBeenCalledWith(rows[1] as unknown as Setting);
		expect(hidden).not.toHaveBeenCalled();
	});
});
