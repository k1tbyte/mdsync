import { type App, type Menu, Modal, TFile, TFolder } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import {
	appendIgnoreRule,
	buildIgnoreRule,
	removeIgnoreRule,
} from "@/settings/ignore-rules";
import { isUnder, spaceOf } from "@/sync/space";
import { notifyError, notifyInfo } from "@/ui/common";
import { openPromiseModal } from "@/ui/modals";
import { ignoreHome, ignoreNoteOf, isIgnoreNote } from "@/vault/ignore";

const IGNORE_RULES_CHANGED = "Ignore rules changed.";

/** One ignore entry per menu: a plain path opens a level picker, an ignored one clears both levels at once. */
export function addIgnoreMenuItem(
	menu: Menu,
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
	titlePrefix = "",
): void {
	const spaces = plugin.spaces.partition();
	// A share's root is its mount point: ignoring it would stop the whole share.
	if (isIgnoreNote(spaces, path) || spaces.some((s) => s.root === path)) {
		return;
	}
	const target = isFolder ? "folder" : "file";
	if (plugin.ignoreState.isIgnored(path)) {
		menu.addItem((item) =>
			item
				.setTitle(`${titlePrefix}Stop ignoring ${target}`)
				.setIcon("eye")
				.onClick(() => void stopIgnoring(plugin, path, isFolder)),
		);
		return;
	}
	menu.addItem((item) =>
		item
			.setTitle(`${titlePrefix}Ignore ${target}`)
			.setIcon("eye-off")
			.onClick(() => void chooseIgnoreLevel(plugin, path, isFolder)),
	);
}

type IgnoreLevel = "local" | "global";

async function chooseIgnoreLevel(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	// A reader's note edit is never pushed: only this device can ignore.
	if (spaceOf(plugin.spaces.partition(), path).readOnly) {
		return toggleLocalIgnore(plugin, path, isFolder);
	}
	const level = await askIgnoreLevel(plugin.app, path, isFolder);
	if (level === "local") await toggleLocalIgnore(plugin, path, isFolder);
	if (level === "global") await toggleGlobalIgnore(plugin, path, isFolder);
}

function askIgnoreLevel(
	app: App,
	path: string,
	isFolder: boolean,
): Promise<IgnoreLevel | null> {
	return openPromiseModal<IgnoreLevel | null>((answer) => {
		const modal = new Modal(app);
		modal.titleEl.setText(`Ignore ${isFolder ? "folder" : "file"}`);
		modal.contentEl.createEl("p", { text: path });
		const buttons = modal.contentEl.createDiv({
			cls: "obsync-modal-buttons",
		});
		const localBtn = buttons.createEl("button", {
			text: "On this machine",
		});
		localBtn.addEventListener("click", () => {
			answer("local");
			modal.close();
		});
		const globalBtn = buttons.createEl("button", { text: "Globally" });
		globalBtn.addClass("mod-cta");
		globalBtn.addEventListener("click", () => {
			answer("global");
			modal.close();
		});
		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => modal.close());
		return modal;
	}, null);
}

export async function toggleLocalIgnore(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const ignored = plugin.ignoreState.isIgnoredLocally(path);
	const rule = buildIgnoreRule(path, isFolder);
	const previous = plugin.settings.ignorePatterns;
	const next = ignored
		? removeIgnoreRule(previous, rule)
		: appendIgnoreRule(previous, rule);
	if (next === previous) {
		notifyInfo(
			"Ignored on this device by another rule. Edit the patterns under Settings → Obsync.",
		);
		return;
	}

	plugin.settings.ignorePatterns = next;
	try {
		await plugin.saveSettings();
	} catch (error) {
		plugin.settings.ignorePatterns = previous;
		notifyError("Could not update the ignore patterns", error);
		return;
	}
	await plugin.ignoreState.refresh();
	plugin.scheduleScopeRefresh(IGNORE_RULES_CHANGED);
	notifyInfo(
		ignored
			? `${target} no longer ignored on this machine.`
			: `${target} ignored on this machine.`,
	);
}

export async function toggleGlobalIgnore(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const ignored = plugin.ignoreState.isIgnoredGlobally(path);
	const { note, inside } = ignoreHome(plugin.spaces.partition(), path);
	const rule = buildIgnoreRule(inside, isFolder);
	const changed = await editIgnoreNote(plugin, note, (content) =>
		ignored ? removeIgnoreRule(content, rule) : appendIgnoreRule(content, rule),
	);
	if (changed === null) return;
	if (!changed) {
		notifyInfo(`Ignored globally by another rule in ${note}.`);
		return;
	}
	await plugin.ignoreState.refresh();
	// The vault event on the note schedules the scope refresh.
	notifyInfo(
		ignored
			? `${target} no longer ignored globally.`
			: `${target} added to ${note}.`,
	);
}

export async function stopIgnoring(
	plugin: PluginHost,
	path: string,
	isFolder: boolean,
): Promise<void> {
	const target = isFolder ? "Folder" : "File";
	const { note, inside } = ignoreHome(plugin.spaces.partition(), path);
	let changed = false;

	const previous = plugin.settings.ignorePatterns;
	const nextPatterns = removeIgnoreRule(
		previous,
		buildIgnoreRule(path, isFolder),
	);
	if (nextPatterns !== previous) {
		plugin.settings.ignorePatterns = nextPatterns;
		try {
			await plugin.saveSettings();
			changed = true;
		} catch (error) {
			plugin.settings.ignorePatterns = previous;
			notifyError("Could not update the ignore patterns", error);
			return;
		}
	}

	const rule = buildIgnoreRule(inside, isFolder);
	if (await editIgnoreNote(plugin, note, (c) => removeIgnoreRule(c, rule))) {
		changed = true;
	}

	if (!changed) {
		notifyInfo(
			`Ignored by another rule. Edit it in Settings → Obsync or ${note}.`,
		);
		return;
	}
	await plugin.ignoreState.refresh();
	plugin.scheduleScopeRefresh(IGNORE_RULES_CHANGED);
	notifyInfo(`${target} no longer ignored.`);
}

/**
 * The vault's rules stop at a share's root: what they kept out becomes exact rules in the share's note, so
 * none of it is shared.
 */
export async function carryVaultIgnores(
	plugin: PluginHost,
	root: string,
): Promise<boolean> {
	const ignored = [...plugin.ignoreState.ignoredPaths()].filter(
		(path) =>
			path !== root &&
			isUnder(path, root) &&
			plugin.ignoreState.isIgnoredGlobally(path),
	);
	const covered = new Set(ignored);
	const rules = ignored
		.filter((path) => !hasAncestorIn(covered, path, root))
		.map((path) =>
			buildIgnoreRule(
				path.slice(root.length + 1),
				plugin.app.vault.getAbstractFileByPath(path) instanceof TFolder,
			),
		);
	if (rules.length === 0) return true;
	const changed = await editIgnoreNote(plugin, ignoreNoteOf(root), (content) =>
		rules.reduce(appendIgnoreRule, content),
	);
	return changed !== null;
}

/** Read, edit, write back; null when it failed (and said so), false when unchanged. */
async function editIgnoreNote(
	plugin: PluginHost,
	note: string,
	edit: (content: string) => string,
): Promise<boolean | null> {
	const { vault } = plugin.app;
	const file = vault.getAbstractFileByPath(note);
	if (file && !(file instanceof TFile)) {
		notifyError(`${note} exists but is not a file.`);
		return null;
	}
	try {
		const content = file ? await vault.read(file) : "";
		const next = edit(content);
		if (next === content) return false;
		// Re-applied on the content as written, should it change since the read.
		if (file) await vault.process(file, edit);
		else await vault.create(note, next);
		return true;
	} catch (error) {
		notifyError(`Could not update ${note}`, error);
		return null;
	}
}

function hasAncestorIn(
	paths: ReadonlySet<string>,
	path: string,
	root: string,
): boolean {
	for (
		let parent = path.slice(0, path.lastIndexOf("/"));
		parent.length > root.length;
		parent = parent.slice(0, parent.lastIndexOf("/"))
	) {
		if (paths.has(parent)) return true;
	}
	return false;
}
