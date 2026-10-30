import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/core/settings/model";
import { createScopePolicy } from "@/features/sync/scope/scope";

describe("ScopePolicy getCategory", () => {
	const scope = createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		configDir: ".obsidian",
	});

	it("identifies core settings files", () => {
		expect(scope.getCategory(".obsidian/app.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/appearance.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/core-plugins.json")).toBe(
			"coreSettings",
		);
		expect(scope.getCategory(".obsidian/graph.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/bookmarks.json")).toBe("coreSettings");
		expect(scope.getCategory(".obsidian/templates.json")).toBe("coreSettings");
	});

	it("identifies hotkeys file", () => {
		expect(scope.getCategory(".obsidian/hotkeys.json")).toBe("hotkeys");
	});

	it("identifies community plugins list", () => {
		expect(scope.getCategory(".obsidian/community-plugins.json")).toBe(
			"pluginList",
		);
	});

	it("identifies plugin configs", () => {
		expect(scope.getCategory(".obsidian/plugins/dataview/data.json")).toBe(
			"pluginConfigs",
		);
		expect(scope.getCategory(".obsidian/plugins/dataview/")).toBe(
			"pluginConfigs",
		);
		expect(
			scope.getCategory(".obsidian/plugins/obsidian-git/data.json"),
		).toBeNull();
		expect(scope.getCategory(".obsidian/plugins/mdsync/data.json")).toBeNull();
	});

	it("identifies snippets", () => {
		expect(scope.getCategory(".obsidian/snippets/custom.css")).toBe("snippets");
		expect(scope.getCategory(".obsidian/snippets/")).toBe("snippets");
	});

	it("identifies themes", () => {
		expect(scope.getCategory(".obsidian/themes/Minimal/theme.css")).toBe(
			"themes",
		);
		expect(scope.getCategory(".obsidian/themes/")).toBe("themes");
	});

	it("returns null for unknown config files", () => {
		expect(scope.getCategory(".obsidian/workspace.json")).toBeNull();
		expect(scope.getCategory(".obsidian/unknown.json")).toBeNull();
	});

	it("returns null for non-config files", () => {
		expect(scope.getCategory("Welcome.md")).toBeNull();
		expect(scope.getCategory("folder/note.md")).toBeNull();
	});
});

describe("ScopePolicy plugin code", () => {
	const scopeOf = (pluginCode?: boolean) =>
		createScopePolicy({
			settingsSync: { ...DEFAULT_SETTINGS_SYNC, pluginConfigs: true },
			pluginCode,
			configDir: ".obsidian",
		});
	const plugin = ".obsidian/plugins/dataview";

	it("takes only each plugin's data.json by default", () => {
		const scope = scopeOf();
		expect(scope.includes(`${plugin}/data.json`)).toBe(true);
		for (const path of [
			`${plugin}/main.js`,
			`${plugin}/manifest.json`,
			`${plugin}/sub/data.json`,
			".obsidian/plugins/data.json",
		]) {
			expect(scope.includes(path)).toBe(false);
		}
		expect(scope.canDescend(".obsidian/plugins")).toBe(true);
		expect(scope.canDescend(plugin)).toBe(true);
		expect(scope.canDescend(`${plugin}/sub`)).toBe(false);
	});

	it("keeps code in its category, so a reset still clears the folder whole", () => {
		expect(scopeOf().getCategory(`${plugin}/main.js`)).toBe("pluginConfigs");
	});

	it("takes plugin folders whole when asked", () => {
		const scope = scopeOf(true);
		expect(scope.includes(`${plugin}/main.js`)).toBe(true);
		expect(scope.includes(`${plugin}/sub/data.json`)).toBe(true);
		expect(scope.canDescend(`${plugin}/sub`)).toBe(true);
	});

	it("keeps MDSync and device-local plugins out in either mode", () => {
		for (const scope of [scopeOf(), scopeOf(true)]) {
			expect(scope.includes(".obsidian/plugins/obsidian-git/data.json")).toBe(
				false,
			);
			expect(scope.includes(".obsidian/plugins/mdsync/data.json")).toBe(false);
		}
	});
});

describe("ScopePolicy isSettingsJson", () => {
	const scope = createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		pluginCode: true,
		configDir: ".obsidian",
	});

	it("names Obsidian's settings and plugins' data.json, never code or notes", () => {
		for (const path of [
			".obsidian/app.json",
			".obsidian/hotkeys.json",
			".obsidian/community-plugins.json",
			".obsidian/plugins/dataview/data.json",
		]) {
			expect(scope.isSettingsJson(path)).toBe(true);
		}
		for (const path of [
			".obsidian/plugins/dataview/manifest.json",
			".obsidian/plugins/dataview/sub/data.json",
			".obsidian/themes/Minimal/manifest.json",
			".obsidian/workspace.json",
			"data.json",
			"note.md",
		]) {
			expect(scope.isSettingsJson(path)).toBe(false);
		}
	});
});
