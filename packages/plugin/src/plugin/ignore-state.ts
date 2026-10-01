import { type Plugin, type TAbstractFile, TFile, TFolder } from "obsidian";

import { type Space, spaceOf } from "@/sync/space";
import {
	createIgnoreMatcher,
	type IgnoreMatcher,
	ignoreNoteOf,
	isIgnoreNote,
} from "@/vault/ignore";
import type { PluginHost } from "./host";

/**
 * Device-local patterns plus each space's syncignore.md, kept in memory so menus answer synchronously without
 * a sync session.
 */
export interface IgnoreStateHandle {
	isIgnored(path: string): boolean;
	isIgnoredLocally(path: string): boolean;
	isIgnoredGlobally(path: string): boolean;
	/** Every loaded file/folder path currently ignored by either source. */
	ignoredPaths(): ReadonlySet<string>;
	subscribe(listener: () => void): () => void;
	/** Reloads every rule source, recomputes the ignored set and notifies. */
	refresh(): Promise<void>;
}

const PASS_THROUGH: IgnoreMatcher = { ignores: () => false };

export function registerIgnoreState(
	plugin: Plugin & PluginHost,
): IgnoreStateHandle {
	const listeners = new Set<() => void>();
	let local: IgnoreMatcher = PASS_THROUGH;
	/** Shared rules per space root. */
	let shared = new Map<string, IgnoreMatcher>();
	let ignored = new Set<string>();
	/** The partition `ignored` was computed for. */
	let computedFor = "";

	const partition = () => plugin.spaces.partition();

	const load = async (root: string): Promise<IgnoreMatcher> => {
		const file = plugin.app.vault.getAbstractFileByPath(ignoreNoteOf(root));
		if (!(file instanceof TFile)) return PASS_THROUGH;
		try {
			return createIgnoreMatcher(await plugin.app.vault.read(file), root);
		} catch {
			return PASS_THROUGH;
		}
	};

	const sharedOf = (root: string): IgnoreMatcher => {
		const hit = shared.get(root);
		if (hit) return hit;
		// A space mounted since the last refresh: its rules arrive a moment later,
		// unless a refresh loaded newer ones meanwhile.
		const loading = shared;
		loading.set(root, PASS_THROUGH);
		void load(root).then((matcher) => {
			if (shared !== loading) return;
			shared.set(root, matcher);
			recompute();
			notify();
		});
		return PASS_THROUGH;
	};

	const locally = (spaces: readonly Space[], path: string): boolean =>
		!isIgnoreNote(spaces, path) && local.ignores(path);
	const globally = (spaces: readonly Space[], path: string): boolean =>
		!isIgnoreNote(spaces, path) &&
		sharedOf(spaceOf(spaces, path).root).ignores(path);
	const ignoredIn = (spaces: readonly Space[], path: string): boolean =>
		locally(spaces, path) || globally(spaces, path);

	const recompute = (): void => {
		const spaces = partition();
		const next = new Set<string>();
		for (const file of plugin.app.vault.getAllLoadedFiles()) {
			if (isTrackable(file.path) && ignoredIn(spaces, probeOf(file))) {
				next.add(file.path);
			}
		}
		ignored = next;
		computedFor = rootsOf(spaces);
	};

	const refresh = async (): Promise<void> => {
		local = createIgnoreMatcher(plugin.settings.ignorePatterns);
		const roots = partition().map((space) => space.root);
		const loaded = await Promise.all(roots.map(load));
		shared = new Map(roots.map((root, i) => [root, loaded[i] ?? PASS_THROUGH]));
		recompute();
		notify();
	};

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	/** Cheap membership updates between full recomputes. */
	const track = (spaces: readonly Space[], file: TAbstractFile): boolean => {
		if (!isTrackable(file.path) || !ignoredIn(spaces, probeOf(file))) {
			return false;
		}
		ignored.add(file.path);
		return true;
	};
	const probe = (path: string): string => {
		const file = plugin.app.vault.getAbstractFileByPath(path);
		return file ? probeOf(file) : path;
	};

	const onVaultChange = (file: TAbstractFile, oldPath?: string): void => {
		const spaces = partition();
		if (
			isIgnoreNote(spaces, file.path) ||
			(oldPath !== undefined && isIgnoreNote(spaces, oldPath))
		) {
			void refresh();
			return;
		}
		let changed = oldPath ? ignored.delete(oldPath) : false;
		changed = track(spaces, file) || changed;
		if (changed) notify();
	};

	plugin.registerEvent(plugin.app.vault.on("create", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("modify", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("delete", onVaultChange));
	plugin.registerEvent(plugin.app.vault.on("rename", onVaultChange));
	plugin.app.workspace.onLayoutReady(() => void refresh());

	return {
		isIgnored: (path) => ignoredIn(partition(), probe(path)),
		isIgnoredLocally: (path) => locally(partition(), probe(path)),
		isIgnoredGlobally: (path) => globally(partition(), probe(path)),
		ignoredPaths() {
			// Shares mount and close on a refresh, which tells nobody here.
			if (rootsOf(partition()) !== computedFor) recompute();
			return ignored;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh,
	};
}

/** Folder rules (`drafts/`) match only a path that ends like a folder. */
function probeOf(file: TAbstractFile): string {
	return file instanceof TFolder ? `${file.path}/` : file.path;
}

function isTrackable(path: string): boolean {
	return path !== "" && path !== "/";
}

function rootsOf(spaces: readonly Space[]): string {
	return spaces.map((space) => space.root).join("\n");
}
