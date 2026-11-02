import { Setting } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EFieldKind } from "@/core/settings";

import {
	type FieldContext,
	fieldRow,
	type NumberField,
} from "@/core/settings/fields";

vi.mock("obsidian", async (importOriginal) => {
	class Setting {
		settingEl = { addClass: () => undefined };
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText(build: (text: unknown) => void) {
			build({
				inputEl: input,
				setValue() {
					return this;
				},
				onChange(handler: (raw: string) => void) {
					typed = handler;
					return this;
				},
			});
			return this;
		}
	}
	return {
		...(await importOriginal<object>()),
		Setting,
		debounce: (fn: unknown) => fn,
	};
});

let typed: (raw: string) => void = () => undefined;
let input: Record<string, string> = {};

const minutes: NumberField = {
	kind: EFieldKind.Number,
	name: "Interval",
	get: (s) => String(s.autoSyncIntervalMinutes),
	parse: (raw) => Math.max(1, Number.parseInt(raw, 10)),
	set: (value) => ({ autoSyncIntervalMinutes: value }),
};

function typeInto(raw: string, field: NumberField = minutes) {
	const settings = { autoSyncIntervalMinutes: 15 };
	const ctx = {
		plugin: { settings, saveSettings: async () => undefined },
		rerender: () => undefined,
	} as unknown as FieldContext;
	input = {};
	fieldRow(ctx, field).render(new Setting({} as HTMLElement));
	typed(raw);
	return settings.autoSyncIntervalMinutes;
}

describe("a number field", () => {
	it.each(["", "  ", "abc", "-3", "1.5e3"])(
		"keeps the setting while %j is typed",
		(raw) => {
			expect(typeInto(raw)).toBe(15);
		},
	);

	it("saves a whole number", () => {
		expect(typeInto("30")).toBe(30);
	});

	it("leaves the input a plain text box without bounds", () => {
		typeInto("30");
		expect(input).toEqual({});
	});

	it("becomes a native number input with its bounds", () => {
		typeInto("30", { ...minutes, min: 1, max: 60 });
		expect(input).toEqual({ type: "number", min: "1", max: "60" });
	});

	it("sets only the bound it has", () => {
		typeInto("30", { ...minutes, min: 0 });
		expect(input).toEqual({ type: "number", min: "0" });
	});
});
