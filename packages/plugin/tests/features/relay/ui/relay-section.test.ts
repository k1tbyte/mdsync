import type { Setting } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FieldContext, fieldRow } from "@/core/settings/fields";
import { relaySection } from "@/features/relay/ui/relay-section";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	Setting: class {
		setName() {
			return this;
		}
		setHeading() {
			return this;
		}
		setDesc() {
			return this;
		}
		addButton() {
			return this;
		}
	},
}));
vi.mock("@/core/settings/fields", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fieldRow: vi.fn(),
	checkRow: vi.fn(),
	group: (_heading: string, items: unknown[]) => ({ items }),
}));
vi.mock("@/core/ui/notices", () => ({
	runWithNotice: vi.fn(async (action: () => Promise<void>) => {
		await action();
		return true;
	}),
}));

const writeText = vi.fn(async () => {});

function relayForm(relaySecret: string) {
	const settings = { relaySecret };
	let label = "";
	let click = async () => {};
	let typed = () => {};
	const button = {
		setButtonText: (text: string) => {
			label = text;
			return button;
		},
		onClick: (handler: () => Promise<void>) => {
			click = handler;
			return button;
		},
	};
	const input = {
		addEventListener: (_: string, listener: () => void) => {
			typed = listener;
		},
	};
	vi.mocked(fieldRow).mockImplementation((_ctx, field) => ({
		name: field.name,
		render: () => {},
	}));
	const saveSettings = vi.fn(async () => {});
	const rerender = vi.fn();
	const definitions = relaySection({
		plugin: { settings, saveSettings },
		rerender,
	} as unknown as FieldContext);
	const row = definitions.items?.find((item) => item.name === "Relay secret");
	if (!row || !("render" in row) || !row.render)
		throw new Error("No relay secret row");
	row.render(
		{
			addButton: (build: (button: unknown) => void) => build(button),
			controlEl: { querySelector: () => input },
		} as unknown as Setting,
		{} as never,
	);
	return {
		settings,
		saveSettings,
		rerender,
		label: () => label,
		click: () => click(),
		type: (value: string) => {
			settings.relaySecret = value;
			typed();
		},
	};
}

describe("the relay secret button", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("navigator", { clipboard: { writeText } });
	});

	it("follows what is typed: Generate while empty, Copy once it has a value", () => {
		const form = relayForm("saved");
		expect(form.label()).toBe("Copy");

		form.type("");
		expect(form.label()).toBe("Generate");

		form.type("typed");
		expect(form.label()).toBe("Copy");
	});

	it("copies a secret typed into an empty field instead of replacing it", async () => {
		const form = relayForm("");
		form.type("mine");

		await form.click();

		expect(writeText).toHaveBeenCalledWith("mine");
		expect(form.settings.relaySecret).toBe("mine");
		expect(form.saveSettings).not.toHaveBeenCalled();
	});

	it("generates, saves and copies a new secret while the field is empty", async () => {
		const form = relayForm("saved");
		form.type("");

		await form.click();

		expect(form.settings.relaySecret).not.toBe("");
		expect(writeText).toHaveBeenCalledWith(form.settings.relaySecret);
		expect(form.saveSettings).toHaveBeenCalledOnce();
		expect(form.rerender).toHaveBeenCalledOnce();
	});
});
