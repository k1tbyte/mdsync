import { describe, expect, it, vi } from "vitest";

import {
	type FieldContext,
	type NumberField,
	renderField,
} from "@/settings/fields";
import { EFieldKind } from "@/storage/field-spec";

vi.mock("obsidian", () => {
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
	return { Setting, debounce: (fn: unknown) => fn };
});

let typed: (raw: string) => void = () => undefined;

const minutes: NumberField = {
	kind: EFieldKind.Number,
	name: "Interval",
	get: (s) => String(s.autoSyncIntervalMinutes),
	parse: (raw) => Math.max(1, Number.parseInt(raw, 10)),
	set: (value) => ({ autoSyncIntervalMinutes: value }),
};

function typeInto(raw: string) {
	const settings = { autoSyncIntervalMinutes: 15 };
	const ctx = {
		plugin: { settings, saveSettings: async () => undefined },
		rerender: () => undefined,
	} as unknown as FieldContext;
	renderField({} as HTMLElement, ctx, minutes);
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
});
