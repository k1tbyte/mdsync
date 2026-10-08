import { type App, debounce, Setting, TFile } from "obsidian";

import { IGNORE_FILE_NAME } from "@/constants";
import {
	type FieldContext,
	renderFields,
	type SettingsField,
	TYPING_SETTLE_MS,
} from "@/settings/fields";
import { NUMERIC_BOUNDS } from "@/settings/model";
import { EFieldKind } from "@/storage";
import { notifyError, notifyInfo, openInEditor, reportError } from "@/ui";

const SCOPE_CHANGED = "Sync scope settings changed.";
const BYTES_PER_MB = 1024 * 1024;
const MIN_MAX_FILE_MB = 1;

const EXCLUSION_FIELDS: ReadonlyArray<SettingsField> = [
	{
		kind: EFieldKind.Toggle,
		name: "Ignore symlinks",
		desc: "Skip symbolic links, Windows junctions and directory links on this device. They can point outside the vault.",
		get: (s) => s.ignoreSymlinks,
		set: (v) => ({ ignoreSymlinks: v }),
		refreshScope: true,
	},
	{
		kind: EFieldKind.Number,
		name: "Max file size (MB)",
		desc: "Skip larger files on this device.",
		get: (s) => String(Math.round(s.maxFileBytes / BYTES_PER_MB)),
		parse: (raw) =>
			Math.min(
				NUMERIC_BOUNDS.maxFileBytes.max / BYTES_PER_MB,
				Math.max(MIN_MAX_FILE_MB, Number.parseInt(raw, 10)),
			),
		set: (mb) => ({ maxFileBytes: mb * BYTES_PER_MB }),
		refreshScope: true,
	},
];

export function renderExclusionsSection(
	parent: HTMLElement,
	ctx: FieldContext,
): void {
	const { plugin } = ctx;
	new Setting(parent).setName("Exclusions").setHeading();
	new Setting(parent)
		.setName("Shared vault rules")
		.setDesc(
			`Stored in ${IGNORE_FILE_NAME} at the vault root and synced to your other devices. Shared folders use their own ${IGNORE_FILE_NAME}.`,
		)
		.addButton((button) =>
			button
				.setButtonText(`Open ${IGNORE_FILE_NAME}`)
				.onClick(() => void openSharedIgnore(plugin.app).catch(reportError)),
		);

	const savePatterns = debounce(
		() => {
			void plugin
				.saveSettings()
				.then(() => plugin.ignoreState.refresh())
				.then(() => plugin.scheduleScopeRefresh(SCOPE_CHANGED))
				.catch(reportError);
		},
		TYPING_SETTLE_MS,
		true,
	);
	const patterns = new Setting(parent)
		.setName("Rules for this device only")
		.setDesc(
			`Added to the shared rules; does not edit ${IGNORE_FILE_NAME}. One gitignore-style pattern per line.`,
		)
		.setClass("mdsync-ignore-patterns");
	patterns.nameEl.id = "mdsync-local-ignore-label";
	patterns.descEl.id = "mdsync-local-ignore-description";
	patterns.addTextArea((text) => {
		text.inputEl.rows = 6;
		text.inputEl.spellcheck = false;
		text.inputEl.setAttribute("aria-labelledby", patterns.nameEl.id);
		text.inputEl.setAttribute("aria-describedby", patterns.descEl.id);
		text
			.setPlaceholder("Attachments/\n*.tmp")
			.setValue(plugin.settings.ignorePatterns)
			.onChange((value) => {
				plugin.settings.ignorePatterns = value;
				savePatterns();
			});
	});
	renderFields(parent, ctx, EXCLUSION_FIELDS);
}

async function openSharedIgnore(app: App): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(IGNORE_FILE_NAME);
	if (existing && !(existing instanceof TFile)) {
		notifyError(`${IGNORE_FILE_NAME} already exists and is not a file.`);
		return;
	}
	if (!existing) {
		await app.vault.create(IGNORE_FILE_NAME, "");
		notifyInfo(`${IGNORE_FILE_NAME} created.`);
	}
	await openInEditor(app, IGNORE_FILE_NAME);
	const { setting } = app as App & { setting?: { close(): void } };
	setting?.close();
}
