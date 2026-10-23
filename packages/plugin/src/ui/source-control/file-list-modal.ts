import {
	type App,
	ButtonComponent,
	Menu,
	Modal,
	SearchComponent,
	TFile,
} from "obsidian";

import {
	appendIconButton,
	copyText,
	type ModalHead,
	makeActivatable,
	modalCard,
	modalFooter,
	modalHint,
	modalSection,
	openInEditor,
	renderModalHead,
	renderPath,
	revealInFileExplorer,
	showMenuAt,
} from "@/ui/common";

export interface ListedFile {
	path: string;
	/** Right of the name, such as its size. */
	aside?: string;
	/** A line under it. */
	detail?: string;
}

export interface FileGroup {
	title: string;
	hint?: string;
	files: readonly ListedFile[];
}

/** One more menu entry; `run` resolves true once the file no longer belongs in the list. */
export interface FileAction {
	title: string;
	icon: string;
	run: (path: string) => Promise<boolean>;
}

/** Past these a filter appears, and rows stop being drawn. */
const FILTER_FROM = 8;
const SHOWN = 200;

/** Files in groups; a row shows its file in the file explorer, its menu opens or copies it. */
export class FileListModal extends Modal {
	private filter = "";
	private groups: FileGroup[];

	constructor(
		app: App,
		private readonly head: ModalHead,
		groups: readonly FileGroup[],
		private readonly action?: FileAction,
	) {
		super(app);
		this.groups = groups.filter(({ files }) => files.length > 0);
	}

	onOpen(): void {
		const { contentEl } = this;
		renderModalHead(this, this.head);
		if (this.total() > FILTER_FROM) this.renderFilter(contentEl);
		const list = contentEl.createDiv({ cls: "mdsync-file-groups" });
		this.renderList(list);
		new ButtonComponent(modalFooter(this))
			.setButtonText("Done")
			.onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private total(): number {
		return this.groups.reduce((sum, { files }) => sum + files.length, 0);
	}

	private renderFilter(parent: HTMLElement): void {
		const search = new SearchComponent(
			parent.createDiv({ cls: "mdsync-file-groups-filter" }),
		).setPlaceholder("Filter by path…");
		search.inputEl.setAttr("aria-label", "Filter files by path");
		search.onChange((value) => {
			this.filter = value.trim().toLowerCase();
			const list = this.contentEl.querySelector<HTMLElement>(
				".mdsync-file-groups",
			);
			if (list) this.renderList(list);
		});
	}

	private renderList(list: HTMLElement): void {
		list.empty();
		let left = SHOWN;
		let matched = 0;
		for (const { title, hint, files } of this.groups) {
			const shown = files.filter(({ path }) =>
				path.toLowerCase().includes(this.filter),
			);
			if (shown.length === 0) continue;
			matched += shown.length;
			if (left === 0) continue;
			modalSection(list, `${title} · ${shown.length.toLocaleString()}`);
			if (hint) modalHint(list, hint);
			const card = modalCard(list);
			for (const file of shown.slice(0, left)) this.renderRow(card, file);
			left = Math.max(0, left - shown.length);
		}
		if (matched === 0) {
			modalHint(
				list,
				this.filter
					? "No files match the filter."
					: "None left. Compare again to update the count.",
			);
		} else if (matched > SHOWN) {
			modalHint(
				list,
				`Showing ${SHOWN} of ${matched.toLocaleString()}. Filter to find the rest.`,
			);
		}
	}

	private renderRow(
		card: HTMLElement,
		{ path, aside, detail }: ListedFile,
	): void {
		const row = card.createDiv({
			cls: "mdsync-modal-row is-compact mdsync-file-groups-row",
		});
		const text = row.createDiv({ cls: "mdsync-modal-row-text" });
		renderPath(text, path);
		if (detail)
			text.createDiv({ cls: "mdsync-modal-row-detail", text: detail });
		if (aside) row.createSpan({ cls: "mdsync-modal-row-aside", text: aside });
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file) {
			makeActivatable(row, null, () => {
				void revealInFileExplorer(this.app, path);
				this.close();
			});
		} else row.addClass("is-missing");
		const name = path.slice(path.lastIndexOf("/") + 1);
		const more = appendIconButton(
			row,
			"more-horizontal",
			`More for ${name}`,
			(event) => {
				// The row behind it would reveal the file.
				event.stopPropagation();
				const menu = new Menu();
				if (file instanceof TFile) {
					menu.addItem((item) =>
						item
							.setTitle("Open")
							.setIcon("file-text")
							.onClick(() => {
								void openInEditor(this.app, path);
								this.close();
							}),
					);
				}
				menu.addItem((item) =>
					item
						.setTitle("Copy path")
						.setIcon("copy")
						.onClick(() => void copyText("Path", path)),
				);
				const action = this.action;
				if (action && file) {
					menu.addItem((item) =>
						item
							.setTitle(action.title)
							.setIcon(action.icon)
							.onClick(() => void this.run(action, path)),
					);
				}
				showMenuAt(menu, more, row);
			},
		);
	}

	private async run(action: FileAction, path: string): Promise<void> {
		if (!(await action.run(path))) return;
		this.groups = this.groups
			.map((group) => ({
				...group,
				files: group.files.filter((file) => file.path !== path),
			}))
			.filter(({ files }) => files.length > 0);
		if (this.groups.length === 0) {
			this.close();
			return;
		}
		const list = this.contentEl.querySelector<HTMLElement>(
			".mdsync-file-groups",
		);
		if (list) this.renderList(list);
	}
}
