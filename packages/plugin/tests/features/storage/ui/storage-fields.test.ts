import type { Setting } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/app/host";
import { settleTyping } from "@/core/settings/fields";
import { EStorageBackend } from "@/features/storage/config";
import { storageRows } from "@/features/storage/ui/storage-fields";

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

describe("backend text fields", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function bucketField() {
		const saveSettings = vi.fn(async () => undefined);
		const plugin = {
			settings: { storageConfigs: {} },
			saveSettings,
		} as unknown as PluginHost;
		let typed: (value: string) => void = () => undefined;
		const setting = {
			addText: (build: (text: unknown) => void) => {
				build({
					inputEl: {},
					setPlaceholder() {},
					setValue() {
						return this;
					},
					onChange(handler: (value: string) => void) {
						typed = handler;
					},
				});
			},
		} as unknown as Setting;
		const row = storageRows(plugin, EStorageBackend.S3).find(
			(r) => r.name === "Bucket",
		);
		row?.render(setting);
		return { plugin, saveSettings, typed };
	}

	it("keep every keystroke in memory and save the last value once", async () => {
		const { plugin, saveSettings, typed } = bucketField();

		for (const value of ["b", "bu", "buck"]) typed(value);
		expect(saveSettings).not.toHaveBeenCalled();
		expect(
			(plugin.settings.storageConfigs[EStorageBackend.S3] as { bucket: string })
				.bucket,
		).toBe("buck");

		await vi.advanceTimersByTimeAsync(800);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it("save what is still settling when the settings close", async () => {
		const { saveSettings, typed } = bucketField();
		typed("buck");

		settleTyping();
		expect(saveSettings).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(800);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});
});
