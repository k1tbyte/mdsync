import { beforeEach, describe, expect, it, vi } from "vitest";

import { type FieldContext, renderField } from "@/settings/fields";
import { renderRelaySection } from "@/settings/sections/relay";

vi.mock("obsidian", () => ({
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
	},
}));
vi.mock("@/settings/fields", () => ({
	renderField: vi.fn(),
	renderCheckRow: vi.fn(),
}));
vi.mock("@/ui/common/notices", () => ({
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
	vi.mocked(renderField)
		.mockReturnValueOnce({} as ReturnType<typeof renderField>)
		.mockReturnValueOnce({
			addButton: (build: (button: unknown) => void) => build(button),
			controlEl: { querySelector: () => input },
		} as unknown as ReturnType<typeof renderField>);
	const saveSettings = vi.fn(async () => {});
	const rerender = vi.fn();
	renderRelaySection(
		{} as HTMLElement,
		{
			plugin: { settings, saveSettings },
			rerender,
		} as unknown as FieldContext,
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
