import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { createIgnoreMatcher } from "@/vault/ignore";
import { createScopePolicy, type ScopeOptions } from "@/vault/scope";

const CONFIG = ".obsidian";

function policy(extra: Partial<ScopeOptions> = {}) {
	return createScopePolicy({
		settingsSync: DEFAULT_SETTINGS_SYNC,
		configDir: CONFIG,
		...extra,
	});
}

describe("scope partition: vault excludes share roots", () => {
	const scope = policy({ otherRoots: ["shared/photos"] });

	it("includes vault files outside the share root", () => {
		expect(scope.includes("notes/a.md")).toBe(true);
		expect(scope.includes("shared/other.md")).toBe(true);
	});

	it("excludes files under the share root", () => {
		expect(scope.includes("shared/photos/pic.png")).toBe(false);
		expect(scope.includes("shared/photos/sub/deep.png")).toBe(false);
	});

	it("excludes the share root folder itself", () => {
		expect(scope.owns("shared/photos")).toBe(false);
	});

	it("includesInDiff also rejects share root paths", () => {
		expect(scope.includesInDiff("shared/photos/pic.png")).toBe(false);
	});

	it("owns returns true for vault files and false for share files", () => {
		expect(scope.owns("notes/a.md")).toBe(true);
		expect(scope.owns("shared/photos/pic.png")).toBe(false);
	});
});

describe("scope partition: share space includes only its subtree", () => {
	const scope = policy({ root: "shared/photos" });

	it("includes files inside the share root", () => {
		expect(scope.includes("shared/photos/pic.png")).toBe(true);
		expect(scope.includes("shared/photos/sub/deep.png")).toBe(true);
	});

	it("excludes files outside the share root", () => {
		expect(scope.includes("notes/a.md")).toBe(false);
		expect(scope.includes("shared/other.md")).toBe(false);
	});

	it("leaves its mount point to no space", () => {
		expect(scope.owns("shared/photos")).toBe(false);
	});
});

describe("a share's own ignore rules", () => {
	const scope = policy({
		root: "shared/photos",
		sharedIgnore: createIgnoreMatcher("/raw/\n*.tmp", "shared/photos"),
		localIgnore: createIgnoreMatcher("syncignore.md"),
	});

	it("read paths inside its root and prune there", () => {
		expect(scope.includes("shared/photos/raw/a.png")).toBe(false);
		expect(scope.includes("shared/photos/b.tmp")).toBe(false);
		expect(scope.includes("shared/photos/a.png")).toBe(true);
		expect(scope.canDescend("shared/photos/raw")).toBe(false);
		expect(scope.canDescend("shared")).toBe(true);
	});

	it("travel with the share in its root's syncignore.md", () => {
		expect(scope.includes("shared/photos/syncignore.md")).toBe(true);
		expect(scope.includes("shared/photos/sub/syncignore.md")).toBe(false);
	});
});

describe("scope partition: nested other root excluded from a share", () => {
	const scope = policy({
		root: "team",
		otherRoots: ["team/private"],
	});

	it("includes files directly under the share root", () => {
		expect(scope.includes("team/a.md")).toBe(true);
	});

	it("excludes files under the nested other root", () => {
		expect(scope.includes("team/private/secret.md")).toBe(false);
		expect(scope.owns("team/private/secret.md")).toBe(false);
	});
});

describe("canDescend for rooted spaces", () => {
	const scope = policy({ root: "shared/photos" });

	it("allows ancestors of the root for traversal", () => {
		expect(scope.canDescend("shared")).toBe(true);
	});

	it("allows the root itself", () => {
		expect(scope.canDescend("shared/photos")).toBe(true);
	});

	it("allows directories inside the root", () => {
		expect(scope.canDescend("shared/photos/sub")).toBe(true);
	});

	it("rejects directories outside the root's lineage", () => {
		expect(scope.canDescend("notes")).toBe(false);
		expect(scope.canDescend("other/dir")).toBe(false);
	});

	it("descends from the vault root, the first ancestor", () => {
		expect(scope.canDescend("")).toBe(true);
	});
});

describe("canDescend with otherRoots", () => {
	const scope = policy({ otherRoots: ["shared/photos"] });

	it("rejects a directory under another root", () => {
		expect(scope.canDescend("shared/photos")).toBe(false);
		expect(scope.canDescend("shared/photos/sub")).toBe(false);
	});

	it("allows other directories", () => {
		expect(scope.canDescend("shared")).toBe(true);
		expect(scope.canDescend("notes")).toBe(true);
	});
});

describe("config dir never in a rooted space", () => {
	const scope = policy({ root: "shared/photos" });

	it("does not include the config dir", () => {
		expect(scope.includes(`${CONFIG}/app.json`)).toBe(false);
	});

	it("does not descend into the config dir", () => {
		expect(scope.canDescend(CONFIG)).toBe(false);
	});

	it("does not include the ignore file", () => {
		expect(scope.includes("syncignore.md")).toBe(false);
	});
});

describe('vault space still works with root="" (default)', () => {
	const scope = policy();

	it("includes ordinary notes", () => {
		expect(scope.includes("notes/a.md")).toBe(true);
	});

	it("includes config when the category is enabled", () => {
		const s = createScopePolicy({
			settingsSync: {
				coreSettings: true,
				hotkeys: false,
				pluginList: false,
				pluginConfigs: false,
				snippets: false,
				themes: false,
			},
			configDir: CONFIG,
		});
		expect(s.includes(`${CONFIG}/app.json`)).toBe(true);
	});

	it("includes the ignore file", () => {
		expect(scope.includes("syncignore.md")).toBe(true);
	});

	it("can descend the vault root", () => {
		expect(scope.canDescend("")).toBe(true);
	});

	it("owns everything by default", () => {
		expect(scope.owns("anything/at/all")).toBe(true);
	});
});
