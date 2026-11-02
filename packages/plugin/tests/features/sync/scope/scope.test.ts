import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC, EPluginLevel } from "@/core/settings/model";
import {
	createScopePolicy,
	type ScopeOptions,
} from "@/features/sync/scope/scope";

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
	const scopeOf = (extra: Partial<ScopeOptions> = {}) =>
		createScopePolicy({
			settingsSync: { ...DEFAULT_SETTINGS_SYNC, pluginConfigs: true },
			configDir: ".obsidian",
			...extra,
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
		const scope = scopeOf({ pluginLevel: EPluginLevel.Data });
		expect(scope.includes(`${plugin}/main.js`)).toBe(true);
		expect(scope.includes(`${plugin}/sub/data.json`)).toBe(true);
		expect(scope.canDescend(`${plugin}/sub`)).toBe(true);
	});

	it("keeps MDSync and device-local plugins out at any level", () => {
		for (const scope of [
			scopeOf(),
			scopeOf({ pluginLevel: EPluginLevel.Data }),
		]) {
			expect(scope.includes(".obsidian/plugins/obsidian-git/data.json")).toBe(
				false,
			);
			expect(scope.includes(".obsidian/plugins/mdsync/data.json")).toBe(false);
		}
	});
});

describe("ScopePolicy plugin levels", () => {
	const scopeOf = (extra: Partial<ScopeOptions> = {}) =>
		createScopePolicy({
			settingsSync: { ...DEFAULT_SETTINGS_SYNC, pluginConfigs: true },
			configDir: ".obsidian",
			...extra,
		});
	const x = ".obsidian/plugins/x";
	const y = ".obsidian/plugins/y";
	const parts = [
		"data.json",
		"manifest.json",
		"main.js",
		"styles.css",
		"",
		"cache.json",
		"sub/a.bin",
	];
	const at = (id: string, part: string) =>
		part ? `.obsidian/plugins/${id}/${part}` : `.obsidian/plugins/${id}`;
	const included = (scope: ReturnType<typeof scopeOf>, id: string) =>
		parts.filter((part) => scope.includes(at(id, part)));

	it.each([
		["Off", EPluginLevel.Off, [], [true, false, false]],
		["Settings", EPluginLevel.Settings, ["data.json"], [true, true, false]],
		[
			"Code",
			EPluginLevel.Code,
			["data.json", "manifest.json", "main.js", "styles.css"],
			[true, true, false],
		],
		["Data", EPluginLevel.Data, parts, [true, true, true]],
	])(
		"syncs at %s level what that level adds to the ones before",
		(_, level, files, dirs) => {
			const scope = scopeOf({ pluginLevels: { x: level } });
			expect(included(scope, "x")).toEqual(files);
			expect([
				scope.canDescend(".obsidian/plugins"),
				scope.canDescend(x),
				scope.canDescend(`${x}/sub`),
			]).toEqual(dirs);
		},
	);

	it("goes down a subfolder of a plugin at the data level", () => {
		const scope = scopeOf({ pluginLevels: { x: EPluginLevel.Data } });
		expect(scope.canDescend(`${x}/sub/deep`)).toBe(true);
		expect(scope.includes(`${x}/sub/deep/b.bin`)).toBe(true);
	});

	it("gives every plugin without its own level the default one", () => {
		const scope = scopeOf({ pluginLevel: EPluginLevel.Code });
		expect(included(scope, "x")).toEqual(included(scope, "y"));
		expect(included(scope, "y")).toContain("main.js");
		expect(included(scope, "y")).not.toContain("cache.json");
	});

	it("lets a plugin's level win over the default, up or down", () => {
		const down = scopeOf({
			pluginLevel: EPluginLevel.Data,
			pluginLevels: { x: EPluginLevel.Settings },
		});
		expect(included(down, "x")).toEqual(["data.json"]);
		expect(included(down, "y")).toEqual(parts);
		expect(down.canDescend(`${x}/sub`)).toBe(false);
		expect(down.canDescend(`${y}/sub`)).toBe(true);

		const up = scopeOf({ pluginLevels: { x: EPluginLevel.Data } });
		expect(included(up, "x")).toEqual(parts);
		expect(included(up, "y")).toEqual(["data.json"]);
		expect(up.canDescend(`${x}/sub`)).toBe(true);
		expect(up.canDescend(`${y}/sub`)).toBe(false);

		const off = scopeOf({ pluginLevels: { x: EPluginLevel.Off } });
		expect(included(off, "x")).toEqual([]);
		expect(off.canDescend(x)).toBe(false);
		expect(included(off, "y")).toEqual(["data.json"]);
	});

	describe("with plugin configuration off", () => {
		const scope = scopeOf({
			settingsSync: DEFAULT_SETTINGS_SYNC,
			pluginLevels: { x: EPluginLevel.Code },
		});

		it("syncs only the plugin with a level", () => {
			expect(included(scope, "x")).toEqual([
				"data.json",
				"manifest.json",
				"main.js",
				"styles.css",
			]);
			expect(included(scope, "y")).toEqual([]);
			expect(scope.includes(".obsidian/app.json")).toBe(false);
			expect(scope.includes(".obsidian/community-plugins.json")).toBe(false);
		});

		it("reaches that plugin through the config folder and nothing else", () => {
			expect(scope.canDescend(".obsidian")).toBe(true);
			expect(scope.canDescend(".obsidian/plugins")).toBe(true);
			expect(scope.canDescend(x)).toBe(true);
			expect(scope.canDescend(`${x}/sub`)).toBe(false);
			expect(scope.canDescend(y)).toBe(false);
			expect(scope.canDescend(".obsidian/snippets")).toBe(false);
		});
	});

	it("does not enter the plugins folder when every level is off", () => {
		const scopes = [
			scopeOf({ settingsSync: DEFAULT_SETTINGS_SYNC }),
			scopeOf({
				settingsSync: DEFAULT_SETTINGS_SYNC,
				pluginLevels: { x: EPluginLevel.Off },
			}),
			scopeOf({
				pluginLevel: EPluginLevel.Off,
				pluginLevels: { x: EPluginLevel.Off },
			}),
		];
		for (const scope of scopes) {
			expect(scope.canDescend(".obsidian/plugins")).toBe(false);
			expect(scope.canDescend(x)).toBe(false);
			expect(included(scope, "x")).toEqual([]);
		}
		expect(scopes[0]?.canDescend(".obsidian")).toBe(false);
	});

	it("never takes MDSync or a device-local plugin, whatever level they are given", () => {
		const levels = {
			mdsync: EPluginLevel.Data,
			"obsidian-git": EPluginLevel.Data,
			"file-recovery": EPluginLevel.Data,
		};
		for (const settingsSync of [
			DEFAULT_SETTINGS_SYNC,
			{ ...DEFAULT_SETTINGS_SYNC, pluginConfigs: true },
		]) {
			const scope = scopeOf({ settingsSync, pluginLevels: levels });
			for (const id of Object.keys(levels)) {
				expect(included(scope, id).filter(Boolean)).toEqual([]);
				expect(scope.canDescend(`.obsidian/plugins/${id}`)).toBe(false);
				expect(scope.pluginIdOf(at(id, "data.json"))).toBeNull();
			}
		}
	});

	it("never takes the folder entry of MDSync or a device-local plugin", () => {
		const scope = scopeOf({
			pluginLevel: EPluginLevel.Data,
			pluginLevels: { mdsync: EPluginLevel.Data },
		});
		for (const id of ["mdsync", "obsidian-git", "file-recovery"]) {
			expect.soft(scope.includes(at(id, "")), `includes ${id}`).toBe(false);
			expect.soft(scope.pluginIdOf(at(id, "")), `pluginIdOf ${id}`).toBeNull();
			expect
				.soft(scope.loadsOnStartup(at(id, "")), `loadsOnStartup ${id}`)
				.toBe(false);
		}
	});

	it("names the plugins whose code Obsidian reads only at startup", () => {
		const scope = scopeOf({ pluginLevel: EPluginLevel.Data });
		for (const part of ["manifest.json", "main.js", "styles.css"]) {
			expect(scope.loadsOnStartup(at("x", part))).toBe(true);
		}
		for (const part of ["data.json", "cache.json", "sub/a.bin", ""]) {
			expect(scope.loadsOnStartup(at("x", part))).toBe(false);
		}
		expect(scope.loadsOnStartup(".obsidian/community-plugins.json")).toBe(true);
		for (const path of [
			".obsidian/app.json",
			".obsidian/snippets/main.js",
			".obsidian/plugins/mdsync/main.js",
			".obsidian/plugins/obsidian-git/main.js",
			"main.js",
			"note.md",
		]) {
			expect(scope.loadsOnStartup(path)).toBe(false);
		}
	});

	it("names the plugin a path belongs to, and none outside the synced ones", () => {
		const scope = scopeOf();
		for (const part of ["data.json", "main.js", "", "sub/a.bin"]) {
			expect(scope.pluginIdOf(at("x", part))).toBe("x");
		}
		for (const path of [
			".obsidian/plugins/mdsync/data.json",
			".obsidian/plugins/obsidian-git/main.js",
			".obsidian/plugins/file-recovery/data.json",
			".obsidian/app.json",
			".obsidian/community-plugins.json",
			".obsidian/snippets/a.css",
			"plugins/x/data.json",
			"note.md",
		]) {
			expect(scope.pluginIdOf(path)).toBeNull();
		}
	});
});

describe("ScopePolicy isSettingsJson", () => {
	const scope = createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		pluginLevel: EPluginLevel.Data,
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
