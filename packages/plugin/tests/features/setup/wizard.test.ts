import { Modal } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { mergeSettings } from "@/app/settings";
import { ESyncMode, enablesRealtime } from "@/features/setup/feature-choices";
import type { SetupHost } from "@/features/setup/host";
import { ESetupStep } from "@/features/setup/step-state";
import { openSetupWizard, type Wizard } from "@/features/setup/wizard";

describe("setup wizard", () => {
	it("shares the sync mode pick with a wizard closed before its relay answered", () => {
		const open = vi.spyOn(Modal.prototype, "open");
		const plugin = { app: {}, settings: {} } as unknown as SetupHost;
		openSetupWizard(plugin, ESetupStep.Features, () => {});
		openSetupWizard(plugin, ESetupStep.Features, () => {});
		const [closed, reopened] = open.mock.contexts as Wizard[];
		const realtime = () =>
			enablesRealtime(closed?.syncMode ?? null, mergeSettings({}));
		expect(realtime()).toBe(true);
		if (reopened) reopened.syncMode = ESyncMode.Manual;
		expect(realtime()).toBe(false);
	});
});
