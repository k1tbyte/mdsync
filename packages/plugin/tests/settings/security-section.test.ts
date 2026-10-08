import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { isStorageConfigured } from "@/settings/model";
import { renderSecuritySection } from "@/settings/sections/security";
import { askNewPassphrase, notifyInfo, reportError } from "@/ui";

vi.mock("@/settings/model", () => ({ isStorageConfigured: vi.fn(() => true) }));
vi.mock("@/crypto/passphrase-cache", () => ({
	clearCachedPassphrase: vi.fn(),
}));
vi.mock("@/ui", () => ({
	askNewPassphrase: vi.fn(),
	notifyInfo: vi.fn(),
	notifyError: vi.fn(),
	reportError: vi.fn(),
}));
vi.mock("obsidian", () => ({
	Setting: class {
		name = "";
		desc = "";
		buttons: TestButton[] = [];
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
			return this;
		}
		addToggle() {
			return this;
		}
		addButton(build: (button: TestButton) => void) {
			const button = new TestButton();
			build(button);
			this.buttons.push(button);
			return this;
		}
	},
}));

const rows: { name: string; desc: string; buttons: TestButton[] }[] = [];

class TestButton {
	text = "";
	disabled = false;
	click: () => Promise<void> = async () => {};
	setButtonText(text: string) {
		this.text = text;
		return this;
	}
	setDestructive() {
		return this;
	}
	setDisabled(disabled: boolean) {
		this.disabled = disabled;
		return this;
	}
	onClick(click: () => Promise<void>) {
		this.click = click;
		return this;
	}
}

function form(loaded = false) {
	const passphrase = {
		has: () => loaded,
		prompt: vi.fn(async () => true),
		forget: vi.fn(async () => {}),
		rotate: vi.fn(async () => 2),
	};
	const rerender = vi.fn();
	renderSecuritySection(
		{} as HTMLElement,
		{ settings: {}, passphrase } as unknown as PluginHost,
		rerender,
	);
	return { passphrase, rerender };
}

function button(text: string) {
	const found = rows.flatMap((row) => row.buttons).find((b) => b.text === text);
	if (!found) throw new Error(`No ${text} button`);
	return found;
}

describe("passphrase settings", () => {
	beforeEach(() => {
		rows.length = 0;
		vi.clearAllMocks();
		vi.mocked(isStorageConfigured).mockReturnValue(true);
		vi.mocked(askNewPassphrase).mockResolvedValue("new-passphrase");
	});

	it("distinguishes an unloaded session from a missing saved passphrase", () => {
		form();
		const row = rows.find((row) => row.name === "Passphrase on this device");
		expect(row?.desc).toContain("Not loaded for this session");
		expect(row?.desc).not.toContain("not set");
		expect(row?.desc).toContain("does not change the vault passphrase");
	});

	it("can forget a saved passphrase before it is loaded", async () => {
		const { passphrase, rerender } = form();
		const forget = button("Forget");
		expect(forget.disabled).toBe(false);
		await forget.click();
		expect(passphrase.forget).toHaveBeenCalledOnce();
		expect(rerender).toHaveBeenCalledOnce();
	});

	it("entering a passphrase does not rotate the vault key", async () => {
		const { passphrase, rerender } = form(true);
		await button("Enter…").click();
		expect(passphrase.prompt).toHaveBeenCalledWith(true);
		expect(passphrase.rotate).not.toHaveBeenCalled();
		expect(rerender).toHaveBeenCalledOnce();
	});

	it("checks current storage settings before asking for passphrases", async () => {
		const { passphrase } = form();
		vi.mocked(isStorageConfigured).mockReturnValue(false);
		await button("Change…").click();
		expect(passphrase.prompt).not.toHaveBeenCalled();
		expect(askNewPassphrase).not.toHaveBeenCalled();
		expect(notifyInfo).toHaveBeenCalledWith(
			"Configure a storage backend first.",
		);
	});

	it("asks for the current passphrase before a new one and disables duplicate clicks", async () => {
		const { passphrase } = form();
		vi.mocked(askNewPassphrase).mockImplementation(async () => {
			expect(passphrase.prompt).toHaveBeenCalledWith(false);
			expect(button("Change…").disabled).toBe(true);
			return "new-passphrase";
		});
		await button("Change…").click();
		expect(passphrase.rotate).toHaveBeenCalledWith("new-passphrase");
		expect(button("Change…").disabled).toBe(false);
	});

	it("cancelling the current passphrase stops the change", async () => {
		const { passphrase } = form();
		passphrase.prompt.mockResolvedValue(false);
		await button("Change…").click();
		expect(askNewPassphrase).not.toHaveBeenCalled();
		expect(passphrase.rotate).not.toHaveBeenCalled();
		expect(button("Change…").disabled).toBe(false);
	});

	it("refreshes the loaded status even when the new passphrase is cancelled", async () => {
		const { passphrase, rerender } = form();
		vi.mocked(askNewPassphrase).mockResolvedValue(null);
		await button("Change…").click();
		expect(passphrase.rotate).not.toHaveBeenCalled();
		expect(rerender).toHaveBeenCalledOnce();
	});

	it("reports rotation failures and re-enables the action", async () => {
		const { passphrase } = form();
		const error = new Error("offline");
		passphrase.rotate.mockRejectedValue(error);
		await button("Change…").click();
		expect(reportError).toHaveBeenCalledWith(error);
		expect(button("Change…").disabled).toBe(false);
	});
});
