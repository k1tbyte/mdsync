import { Setting, type SettingDefinitionRender } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EFieldKind } from "@/core/settings";
import {
	bind,
	type FieldContext,
	fieldRow,
	group,
	introRow,
	renderDefinitions,
	type SettingsRow,
	type SliderField,
	type ToggleField,
} from "@/core/settings/fields";
import { notifyError } from "@/core/ui/notices";

vi.mock("@/core/ui/notices", () => ({ notifyError: vi.fn() }));

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	debounce: (fn: unknown) => fn,
	Setting: class {
		name = "";
		desc = "";
		heading = false;
		constructor() {
			rows.push(this);
		}
		addToggle(build: (toggle: unknown) => void) {
			build({
				setValue() {
					return this;
				},
				onChange(handler: (value: boolean) => void) {
					toggled = handler;
					return this;
				},
			});
			return this;
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
let toggled: (value: boolean) => void = () => undefined;

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

describe("a field's save", () => {
	function toggleRow(saveSettings: () => Promise<void>) {
		const settings = { liveEditing: false };
		const after = vi.fn();
		const ctx = {
			plugin: { settings, saveSettings },
			rerender: vi.fn(),
		} as unknown as FieldContext;
		fieldRow(ctx, {
			kind: EFieldKind.Toggle,
			name: "Live editing",
			...bind("liveEditing"),
			after,
			rerender: true,
		}).render(new Setting({} as HTMLElement));
		return { settings, after, ctx };
	}

	it("tells the user when settings cannot be saved, and skips what follows", async () => {
		const failure = new Error("disk full");
		const { settings, after, ctx } = toggleRow(() => Promise.reject(failure));

		toggled(true);
		await vi.waitFor(() => expect(notifyError).toHaveBeenCalled());

		expect(notifyError).toHaveBeenCalledWith(
			"Could not save settings",
			failure,
		);
		expect(settings.liveEditing).toBe(true);
		expect(after).not.toHaveBeenCalled();
		expect(ctx.rerender).not.toHaveBeenCalled();
	});

	it("runs what follows once saved", async () => {
		vi.mocked(notifyError).mockClear();
		const { after, ctx } = toggleRow(async () => undefined);

		toggled(true);
		await vi.waitFor(() => expect(after).toHaveBeenCalled());

		expect(ctx.rerender).toHaveBeenCalled();
		expect(notifyError).not.toHaveBeenCalled();
	});
});

describe("bind", () => {
	it("reads and patches one key", () => {
		const field = bind("autoSyncEnabled");
		expect(field.get({ autoSyncEnabled: true } as never)).toBe(true);
		expect(field.set(false)).toEqual({ autoSyncEnabled: false });
	});

	it("only fits a field of the key's value type", () => {
		const toggle = (field: ToggleField) => field;
		const slider = (field: SliderField) => field;
		const range = { min: 0, max: 1 };
		toggle({ kind: EFieldKind.Toggle, name: "ok", ...bind("autoSyncEnabled") });
		slider({
			kind: EFieldKind.Slider,
			name: "ok",
			...range,
			...bind("autoPushSettleSeconds"),
		});
		// @ts-expect-error a number setting is no toggle
		toggle({
			kind: EFieldKind.Toggle,
			name: "no",
			...bind("autoPushSettleSeconds"),
		});
		// @ts-expect-error a boolean setting is no slider
		slider({
			kind: EFieldKind.Slider,
			name: "no",
			...range,
			...bind("autoSyncEnabled"),
		});
	});
});
