import { PLUGIN_ID } from "@/core/constants";
import { EPluginLevel, type SettingsSyncCategories } from "@/core/settings";
import {
	hasDotSegment,
	normalizePath,
	stripTrailingSlash,
} from "@/core/shared";
import type { SymlinkDetector } from "@/core/vault";
import { isUnder } from "../remote/space";
import { EFileKind } from "../types";
import { type IgnoreMatcher, ignoreNoteOf } from "./ignore";

/** community-plugins.json is absent on purpose: it has its own toggle, which "core settings" would bypass. */
const CONFIG_CORE_FILES: ReadonlyArray<string> = [
	"app.json",
	"appearance.json",
	"core-plugins.json",
	"graph.json",
	"bookmarks.json",
	"templates.json",
];

const CONFIG_HOTKEYS_FILE = "hotkeys.json";

const CONFIG_SNIPPETS_DIR = "snippets/";

const CONFIG_THEMES_DIR = "themes/";

const CONFIG_PLUGINS_DIR = "plugins/";

/** Where `Plugin.saveData` writes a plugin's settings. */
const PLUGIN_DATA_FILE = "data.json";

/** What Obsidian's installer writes; the rest of a plugin folder is the plugin's own data. */
const PLUGIN_CODE_FILES: ReadonlyArray<string> = [
	"manifest.json",
	"main.js",
	"styles.css",
];

const CONFIG_FILE_DENYLIST: ReadonlyArray<string> = [
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
	"types.json",
	"sync.json",
];

const CONFIG_SUBDIR_DENYLIST: ReadonlyArray<string> = [".cache/"];

const VAULT_SUBDIR_DENYLIST: ReadonlyArray<string> = [".trash/", ".git/"];

/** Finder's custom folder icon: empty, the icon lives in a resource fork. Android cannot even name it. */
const MAC_FOLDER_ICON = "Icon\r";

const DEVICE_LOCAL_PLUGIN_IDS: ReadonlyArray<string> = [
	"obsidian-git",
	"file-recovery",
];

export interface ScopePolicy {
	readonly configDir?: string;
	includes(path: string): boolean;
	canDescend(dir: string): boolean;
	/** The path lies in this space's part of the vault, included or not. */
	owns(path: string): boolean;
	classify(path: string): EFileKind;
	isIgnoredByPattern(path: string): boolean;
	getCategory(path: string): keyof SettingsSyncCategories | null;
	/** Obsidian's settings or a plugin's `data.json`: JSON written by `JSON.stringify`, so a conflict merges by key. */
	isSettingsJson(path: string): boolean;
	/** Plugin code or the enabled list: Obsidian reads them only when it starts. */
	loadsOnStartup(path: string): boolean;
	/** The synced plugin a path lies in; null outside plugins, for MDSync and device-local ones. */
	pluginIdOf(path: string): string | null;
}

export interface ScopeOptions {
	settingsSync: SettingsSyncCategories;
	/** Every plugin's level while `pluginConfigs` is on; Settings by default. */
	pluginLevel?: EPluginLevel;
	/** Plugins whose level differs from the default; they apply with `pluginConfigs` off too. */
	pluginLevels?: Readonly<Record<string, EPluginLevel>>;
	configDir: string;
	/** The space's own rules, read inside its root. */
	sharedIgnore?: IgnoreMatcher;
	localIgnore?: IgnoreMatcher;
	symlinks?: SymlinkDetector;
	/** Folder this space covers; "" (default) for the vault. */
	root?: string;
	/** Roots of the spaces inside this one: their paths are theirs. */
	otherRoots?: readonly string[];
}

/** The level of a plugin without one of its own. */
export function defaultPluginLevel(
	settingsSync: SettingsSyncCategories,
	pluginLevel: EPluginLevel = EPluginLevel.Settings,
): EPluginLevel {
	return settingsSync.pluginConfigs ? pluginLevel : EPluginLevel.Off;
}

export function createScopePolicy(options: ScopeOptions): ScopePolicy {
	const configDir = stripTrailingSlash(options.configDir);
	const configPrefix = `${configDir}/`;
	// No trailing slash: the folder entry itself must stay out too.
	const ownPluginDir = `${configDir}/plugins/${PLUGIN_ID}`;

	const coreFiles = CONFIG_CORE_FILES.map((f) => `${configDir}/${f}`);
	const hotkeysFile = `${configDir}/${CONFIG_HOTKEYS_FILE}`;
	const communityPluginsFile = `${configDir}/community-plugins.json`;
	const pluginsDir = `${configDir}/${CONFIG_PLUGINS_DIR}`;
	const snippetsDir = `${configDir}/${CONFIG_SNIPPETS_DIR}`;
	const themesDir = `${configDir}/${CONFIG_THEMES_DIR}`;

	const deniedConfigFiles = CONFIG_FILE_DENYLIST.map(
		(f) => `${configDir}/${f}`,
	);
	const deniedConfigDirs = CONFIG_SUBDIR_DENYLIST.map(
		(d) => `${configDir}/${d}`,
	);
	const deviceLocalPluginDirs = DEVICE_LOCAL_PLUGIN_IDS.map(
		(id) => `${pluginsDir}${id}`,
	);

	const sync = { ...options.settingsSync };
	const defaultLevel = defaultPluginLevel(sync, options.pluginLevel);
	const pluginLevels = new Map(Object.entries(options.pluginLevels ?? {}));
	const levelOf = (id: string): EPluginLevel =>
		pluginLevels.get(id) ?? defaultLevel;
	const anyPluginSynced =
		defaultLevel > EPluginLevel.Off ||
		[...pluginLevels.values()].some((level) => level > EPluginLevel.Off);
	const sharedIgnoreMatcher = options.sharedIgnore;
	const localIgnoreMatcher = options.localIgnore;
	const symlinks = options.symlinks;
	const root = stripTrailingSlash(normalizePath(options.root ?? ""));
	const otherRoots = (options.otherRoots ?? []).map((r) =>
		stripTrailingSlash(normalizePath(r)),
	);
	const partitioned = root !== "" || otherRoots.length > 0;
	const ignoreNote = ignoreNoteOf(root);

	return {
		configDir,
		// Anything else stays frozen: an ignore rule or another space never reads as a deletion.
		includes(rawPath) {
			const path = normalizePath(rawPath);
			if (!owns(path) || !isPathAllowed(path)) return false;
			if (isIgnoreFile(path)) return true;
			if (isSharedIgnored(path) || isLocalIgnored(path)) return false;
			return true;
		},
		canDescend(rawDir) {
			const dir = normalizePath(rawDir);
			if (!dir) return true;
			const dirPath = `${dir}/`;
			// Inside this space, or on the way down to its root.
			if (!isUnder(dir, root) && !isUnder(root, dir)) return false;
			if (otherRoots.some((other) => isUnder(dir, other))) return false;
			if (isInVaultDenylist(dirPath)) return false;
			if (symlinks?.isLink(dir)) return false;
			if (isUnder(dir, ownPluginDir)) return false;
			if (
				isIgnoredDir(sharedIgnoreMatcher, dirPath) ||
				isIgnoredDir(localIgnoreMatcher, dirPath)
			) {
				return false;
			}

			if (dir === configDir) return hasConfigDescendants();
			// Config directory is the only dot segment allowed, never one nested inside it.
			if (hasDotSegment(stripConfigPrefix(dir, configPrefix))) return false;
			if (dirPath.startsWith(configPrefix)) return canDescendConfigDir(dirPath);
			return true;
		},
		owns(rawPath) {
			// The scanner asks for every cached path; the vault alone owns all.
			return !partitioned || owns(normalizePath(rawPath));
		},
		classify(rawPath) {
			const path = normalizePath(rawPath);
			if (path.startsWith(pluginsDir)) return EFileKind.Plugin;
			if (path.startsWith(configPrefix)) return EFileKind.Config;
			return EFileKind.Vault;
		},
		isIgnoredByPattern(rawPath) {
			const path = normalizePath(rawPath);
			if (!path || !owns(path)) return false;
			if (isInVaultDenylist(path)) return false;
			if (isUnder(path, ownPluginDir)) return false;
			if (path.startsWith(configPrefix)) return false;
			if (hasDotSegment(path)) return false;
			if (isIgnoreFile(path)) return false;
			return isSharedIgnored(path) || isLocalIgnored(path);
		},
		getCategory(rawPath) {
			return configCategory(normalizePath(rawPath));
		},
		isSettingsJson(rawPath) {
			const path = normalizePath(rawPath);
			const category = configCategory(path);
			if (category === "pluginConfigs") {
				return (
					path === `${pluginsDir}${pluginPath(path).id}/${PLUGIN_DATA_FILE}`
				);
			}
			return (
				category === "coreSettings" ||
				category === "hotkeys" ||
				category === "pluginList"
			);
		},
		loadsOnStartup(rawPath) {
			const path = normalizePath(rawPath);
			if (path === communityPluginsFile) return true;
			return (
				configCategory(path) === "pluginConfigs" &&
				pluginPath(path).needs === EPluginLevel.Code
			);
		},
		pluginIdOf(rawPath) {
			const path = normalizePath(rawPath);
			return configCategory(path) === "pluginConfigs"
				? pluginPath(path).id
				: null;
		},
	};

	/** A share's root folder is its mount point, in no space: never published, never removed. */
	function owns(path: string): boolean {
		return (
			path !== root &&
			isUnder(path, root) &&
			!otherRoots.some((other) => isUnder(path, other))
		);
	}

	function isPathAllowed(path: string): boolean {
		if (!path) return false;
		if (path === MAC_FOLDER_ICON || path.endsWith(`/${MAC_FOLDER_ICON}`)) {
			return false;
		}
		if (isInVaultDenylist(path)) return false;
		if (isUnder(path, ownPluginDir)) return false;
		// Device-local like ignore patterns: excluded from diff so links are not read as deletions.
		if (symlinks?.isLink(path)) return false;

		// Check before config branch: nested .git or .cache must not ride along with plugin config.
		if (hasDotSegment(stripConfigPrefix(path, configPrefix))) return false;
		if (path.startsWith(configPrefix)) {
			return isConfigAllowed(path);
		}
		return true;
	}

	function isIgnoreFile(path: string): boolean {
		return path === ignoreNote;
	}

	function isSharedIgnored(path: string): boolean {
		if (isIgnoreFile(path)) return false;
		return Boolean(sharedIgnoreMatcher?.ignores(path));
	}

	function isLocalIgnored(path: string): boolean {
		if (isIgnoreFile(path)) return false;
		return Boolean(localIgnoreMatcher?.ignores(path));
	}

	/** A plugin part above its plugin's level stays frozen like a disabled category; the category stays whole for resets. */
	function isConfigAllowed(path: string): boolean {
		const category = configCategory(path);
		if (category === "pluginConfigs") {
			const { id, needs } = pluginPath(path);
			return levelOf(id) >= needs;
		}
		return category !== null && sync[category];
	}

	/** For a `pluginConfigs` path: its plugin and the level that syncs it. */
	function pluginPath(path: string): { id: string; needs: EPluginLevel } {
		const [id = "", file, ...rest] = path.slice(pluginsDir.length).split("/");
		// Directly in `plugins/` is a stray file: folders go through `canDescend`.
		if (file === undefined || rest.length > 0) {
			return { id, needs: EPluginLevel.Data };
		}
		if (file === PLUGIN_DATA_FILE) return { id, needs: EPluginLevel.Settings };
		if (PLUGIN_CODE_FILES.includes(file)) {
			return { id, needs: EPluginLevel.Code };
		}
		return { id, needs: EPluginLevel.Data };
	}

	function configCategory(path: string): keyof SettingsSyncCategories | null {
		if (!path.startsWith(configPrefix) || isUnder(path, ownPluginDir))
			return null;
		if (hasDotSegment(stripConfigPrefix(path, configPrefix))) return null;
		if (
			deniedConfigFiles.includes(path) ||
			deniedConfigDirs.some((d) => path.startsWith(d))
		)
			return null;
		if (coreFiles.includes(path)) return "coreSettings";
		if (path === hotkeysFile) return "hotkeys";
		if (path === communityPluginsFile) return "pluginList";
		if (
			path.startsWith(pluginsDir) &&
			!deviceLocalPluginDirs.some((d) => isUnder(path, d))
		)
			return "pluginConfigs";
		if (path.startsWith(snippetsDir)) return "snippets";
		if (path.startsWith(themesDir)) return "themes";
		return null;
	}

	function hasConfigDescendants(): boolean {
		return Object.values(sync).some((enabled) => enabled) || anyPluginSynced;
	}

	function canDescendConfigDir(dirPath: string): boolean {
		if (deniedConfigDirs.some((d) => dirPath === d || dirPath.startsWith(d)))
			return false;
		if (dirPath.startsWith(pluginsDir)) {
			if (deviceLocalPluginDirs.some((d) => isUnder(dirPath, d))) return false;
			const [id, ...below] = dirPath
				.slice(pluginsDir.length)
				.split("/")
				.filter(Boolean);
			if (id === undefined) return anyPluginSynced;
			// `<id>/` holds the settings file; anything deeper is the plugin's data.
			return (
				levelOf(id) >=
				(below.length > 0 ? EPluginLevel.Data : EPluginLevel.Settings)
			);
		}
		if (dirPath.startsWith(snippetsDir)) return sync.snippets;
		if (dirPath.startsWith(themesDir)) return sync.themes;
		return false;
	}
}

function isInVaultDenylist(path: string): boolean {
	return VAULT_SUBDIR_DENYLIST.some((d) => path.startsWith(d));
}

/** Config directory starts with a dot; everything below needs dot segment checking. */
function stripConfigPrefix(path: string, configPrefix: string): string {
	return path.startsWith(configPrefix) ? path.slice(configPrefix.length) : path;
}

function isIgnoredDir(
	matcher: IgnoreMatcher | undefined,
	dirPath: string,
): boolean {
	if (!matcher) return false;
	return matcher.ignores(dirPath);
}
