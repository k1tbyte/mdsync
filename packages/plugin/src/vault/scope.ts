import { PLUGIN_ID } from "@/constants";
import type { SettingsSyncCategories } from "@/settings/model";
import { hasDotSegment, normalizePath, stripTrailingSlash } from "@/shared";
import { isUnder } from "@/sync/space";
import { EFileKind } from "@/sync/types";
import { type IgnoreMatcher, ignoreNoteOf } from "./ignore";
import type { SymlinkDetector } from "./symlinks";

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

const CONFIG_FILE_DENYLIST: ReadonlyArray<string> = [
	"workspace.json",
	"workspace-mobile.json",
	"workspaces.json",
	"types.json",
	"sync.json",
];

const CONFIG_SUBDIR_DENYLIST: ReadonlyArray<string> = [".cache/"];

const VAULT_SUBDIR_DENYLIST: ReadonlyArray<string> = [".trash/", ".git/"];

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
}

export interface ScopeOptions {
	settingsSync: SettingsSyncCategories;
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

export function createScopePolicy(options: ScopeOptions): ScopePolicy {
	const configDir = stripTrailingSlash(options.configDir);
	const configPrefix = `${configDir}/`;
	const ownPluginPrefix = `${configDir}/plugins/${PLUGIN_ID}/`;

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
	const deviceLocalPluginPrefixes = DEVICE_LOCAL_PLUGIN_IDS.map(
		(id) => `${pluginsDir}${id}/`,
	);

	const sync = { ...options.settingsSync };
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
			if (dirPath.startsWith(ownPluginPrefix)) return false;
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
			if (path.startsWith(ownPluginPrefix)) return false;
			if (path.startsWith(configPrefix)) return false;
			if (hasDotSegment(path)) return false;
			if (isIgnoreFile(path)) return false;
			return isSharedIgnored(path) || isLocalIgnored(path);
		},
		getCategory(rawPath) {
			return configCategory(normalizePath(rawPath));
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
		if (isInVaultDenylist(path)) return false;
		if (path.startsWith(ownPluginPrefix)) return false;
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

	function isConfigAllowed(path: string): boolean {
		const category = configCategory(path);
		return category !== null && sync[category];
	}

	function configCategory(path: string): keyof SettingsSyncCategories | null {
		if (!path.startsWith(configPrefix) || path.startsWith(ownPluginPrefix))
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
			!deviceLocalPluginPrefixes.some((p) => path.startsWith(p))
		)
			return "pluginConfigs";
		if (path.startsWith(snippetsDir)) return "snippets";
		if (path.startsWith(themesDir)) return "themes";
		return null;
	}

	function hasConfigDescendants(): boolean {
		return Object.values(sync).some((enabled) => enabled);
	}

	function canDescendConfigDir(dirPath: string): boolean {
		if (deniedConfigDirs.some((d) => dirPath === d || dirPath.startsWith(d)))
			return false;
		if (dirPath.startsWith(pluginsDir)) {
			if (!sync.pluginConfigs) return false;
			return !deviceLocalPluginPrefixes.some(
				(p) => dirPath === p || dirPath.startsWith(p),
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
