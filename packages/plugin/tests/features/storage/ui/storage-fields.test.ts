// @vitest-environment jsdom
import type { Setting } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settleTyping } from "@/core/settings/fields";
import { notifyError } from "@/core/ui/notices";
import { EStorageBackend } from "@/features/storage/config";
import type { StorageHost } from "@/features/storage/host";
import { storageRows } from "@/features/storage/ui/storage-fields";

vi.mock("@/core/ui/notices", () => ({
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
}));

vi.mock("obsidian", async (importActual) => ({
	...(await importActual<object>()),
	debounce: (fn: (...args: unknown[]) => void, ms: number) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending: unknown[] | null = null;
		const fire = () => {
			clearTimeout(timer);
			const args = pending;
			pending = null;
			if (args) fn(...args);
		};
		return Object.assign(
			(...args: unknown[]) => {
				pending = args;
				clearTimeout(timer);
				timer = setTimeout(fire, ms);
			},
			{ run: fire },
		);
	},
}));

interface S3Settings {
	bucket: string;
	secretAccessKey: string;
	concurrency: number;
	forcePathStyle: boolean;
}

describe("backend fields", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(notifyError).mockClear();
	});

	function backend(saveSettings = vi.fn(async () => undefined)) {
		const plugin = {
			settings: { storageConfigs: {} },
			saveSettings,
			scheduleScopeRefresh: vi.fn(),
		} as unknown as StorageHost;
		const rows = storageRows({ plugin, rerender: vi.fn() }, EStorageBackend.S3);
		const config = () =>
			plugin.settings.storageConfigs[
				EStorageBackend.S3
			] as unknown as S3Settings;

		function field(name: string) {
			const input = document.createElement("input");
			let changed: (value: string) => void = () => undefined;
			let toggled: (value: boolean) => void = () => undefined;
			const setting = {
				settingEl: document.createElement("div"),
				addText: (build: (text: unknown) => void) => {
					build({
						inputEl: input,
						setPlaceholder() {},
						setValue(value: string) {
							input.value = value;
							return this;
						},
						onChange(handler: (value: string) => void) {
							changed = handler;
							return this;
						},
					});
				},
				addToggle: (build: (toggle: unknown) => void) => {
					build({
						setValue() {
							return this;
						},
						onChange(handler: (value: boolean) => void) {
							toggled = handler;
							return this;
						},
					});
				},
			} as unknown as Setting;
			rows.find((row) => row.name === name)?.render(setting);
			return {
				input,
				type: (value: string) => changed(value),
				toggle: (value: boolean) => toggled(value),
			};
		}

		return { plugin, saveSettings, config, field };
	}

	it("keep every keystroke in memory and save the last value once", async () => {
		const { saveSettings, config, field } = backend();
		const { type } = field("Bucket");

		for (const value of ["b", "bu", "buck"]) type(value);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(config().bucket).toBe("buck");

		await vi.advanceTimersByTimeAsync(800);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it("save what is still settling when the settings close", async () => {
		const { saveSettings, field } = backend();
		field("Bucket").type("buck");

		settleTyping();
		expect(saveSettings).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(800);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it("trim a text field but keep the spaces of a password", () => {
		const { config, field } = backend();

		field("Bucket").type("  buck ");
		field("Secret access key").type(" se cret ");

		expect(config().bucket).toBe("buck");
		expect(config().secretAccessKey).toBe(" se cret ");
	});

	it("patch the config as it is now, not as it was when the row drew", () => {
		const { plugin, config, field } = backend();
		const bucket = field("Bucket");
		const secret = field("Secret access key");

		bucket.type("buck");
		const replaced = plugin.settings.storageConfigs[EStorageBackend.S3];
		secret.type("secret");

		expect(config().bucket).toBe("buck");
		expect(config().secretAccessKey).toBe("secret");
		expect(plugin.settings.storageConfigs[EStorageBackend.S3]).not.toBe(
			replaced,
		);
	});

	it("save a toggle at once", async () => {
		const { saveSettings, config, field } = backend();

		field("Force path-style URLs").toggle(false);

		expect(config().forcePathStyle).toBe(false);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it("draw concurrency as a native number input with its bounds", () => {
		const { field } = backend();
		const { input } = field("Concurrency");

		expect(input.type).toBe("number");
		expect(input.min).toBe("1");
		expect(input.max).toBe("32");
		expect(input.value).toBe("4");
	});

	it("clamp a typed number into its bounds", () => {
		const { config, field } = backend();
		const { type } = field("Concurrency");

		type("100");
		expect(config().concurrency).toBe(32);
		type("0");
		expect(config().concurrency).toBe(1);
		type("8");
		expect(config().concurrency).toBe(8);
	});

	it("accept only whole numbers", () => {
		const { plugin, field } = backend();
		const { type } = field("Concurrency");

		for (const raw of ["", "abc", "-3", "1.5", "1e1"]) type(raw);

		expect(plugin.settings.storageConfigs).toEqual({});
	});

	it("tell the user when the settings cannot be saved", async () => {
		const failure = new Error("disk full");
		const { field } = backend(vi.fn(() => Promise.reject(failure)));

		field("Force path-style URLs").toggle(true);
		await vi.advanceTimersByTimeAsync(0);

		expect(notifyError).toHaveBeenCalledWith(
			"Could not save settings",
			failure,
		);
	});
});

describe("the Google Drive rows", () => {
	it("add the account row after the fields", () => {
		const plugin = {
			settings: { storageConfigs: {} },
		} as unknown as StorageHost;
		const names = storageRows(
			{ plugin, rerender: vi.fn() },
			EStorageBackend.GoogleDrive,
		).map((row) => row.name);

		expect(names.at(-1)).toBe("Google account");
		expect(names).toContain("Folder Name");
	});
});
