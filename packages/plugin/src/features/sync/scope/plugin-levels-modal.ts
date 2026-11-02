import {
	type App,
	ButtonComponent,
	type DataAdapter,
	Modal,
	SearchComponent,
} from "obsidian";
import { EPluginLevel } from "@/core/settings";
import {
	modalCard,
	modalFooter,
	modalHint,
	renderModalHead,
	renderSegments,
} from "@/core/ui";
import type { Manifest } from "../types";
import type { ScopePolicy } from "./scope";

export const PLUGIN_LEVEL_OPTIONS = [
	{ value: EPluginLevel.Off, text: "Off" },
	{ value: EPluginLevel.Settings, text: "Settings" },
	{ value: EPluginLevel.Code, text: "Code" },
	{ value: EPluginLevel.Data, text: "All" },
] as const;

export interface PluginEntry {
	id: string;
	name: string;
	/** Its code is on this device. */
	installed: boolean;
}

export interface PluginLevelsChoice {
	plugins: readonly PluginEntry[];
	/** False before a compare: plugins only on other devices are missing. */
	remoteKnown: boolean;
	defaultLevel: EPluginLevel;
	levels(): Readonly<Record<string, EPluginLevel>>;
	save(levels: Record<string, EPluginLevel>): Promise<void>;
	onClose(): void;
}

/** Plugin folders here and plugins only the remote holds, named by their manifest here. */
export async function listPlugins(
	adapter: DataAdapter,
	scope: ScopePolicy,
	configDir: string,
	remote: Manifest | null,
): Promise<PluginEntry[]> {
	const pluginsDir = `${configDir}/plugins`;
	const local = await adapter.list(pluginsDir).then(
		(listed) => listed.folders,
		() => [],
	);
	const ids = new Set<string>();
	for (const path of [...local, ...Object.keys(remote?.files ?? {})]) {
		const id = scope.pluginIdOf(path);
		if (id) ids.add(id);
	}
	const entries = await Promise.all(
		[...ids].map(async (id): Promise<PluginEntry> => {
			const name = await manifestName(
				adapter,
				`${pluginsDir}/${id}/manifest.json`,
			);
			return { id, name: name ?? id, installed: name !== null };
		}),
	);
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function manifestName(
	adapter: DataAdapter,
	path: string,
): Promise<string | null> {
	try {
		const { name } = JSON.parse(await adapter.read(path)) as {
			name?: unknown;
		};
		return typeof name === "string" && name ? name : null;
	} catch {
		return null;
	}
}

export class PluginLevelsModal extends Modal {
	private filter = "";

	constructor(
		app: App,
		private readonly choice: PluginLevelsChoice,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, choice } = this;
		const fallback = PLUGIN_LEVEL_OPTIONS[choice.defaultLevel].text;
		renderModalHead(this, {
			icon: "puzzle",
			title: "Choose per plugin",
			sub: `On this device only. Each level includes the one before; the rest follow Plugins: ${fallback}.`,
		});
		const body = contentEl.createDiv({ cls: "mdsync-plugin-levels" });
		const search = new SearchComponent(body).setPlaceholder("Filter plugins…");
		search.inputEl.setAttr("aria-label", "Filter plugins");
		const list = body.createDiv();
		search.onChange((value) => {
			this.filter = value.trim().toLowerCase();
			this.renderList(list);
		});
		this.renderList(list);
		if (!choice.remoteKnown) {
			modalHint(
				body,
				"Plugins only on other devices appear after Check remote.",
			);
		}
		new ButtonComponent(modalFooter(this))
			.setButtonText("Done")
			.onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
		this.choice.onClose();
	}

	private renderList(list: HTMLElement): void {
		list.empty();
		const shown = this.choice.plugins.filter(
			({ id, name }) =>
				id.toLowerCase().includes(this.filter) ||
				name.toLowerCase().includes(this.filter),
		);
		if (shown.length === 0) {
			modalHint(
				list,
				this.filter ? "No plugins match the filter." : "No plugins found.",
			);
			return;
		}
		const card = modalCard(list);
		for (const entry of shown) this.renderRow(card, entry);
	}

	private renderRow(
		card: HTMLElement,
		{ id, name, installed }: PluginEntry,
	): void {
		const { choice } = this;
		const row = card.createDiv({
			cls: "mdsync-modal-row is-compact mdsync-plugin-level-row",
		});
		const text = row.createDiv({ cls: "mdsync-modal-row-text" });
		const custom = text
			.createDiv({ cls: "mdsync-modal-row-name", text: name })
			.createSpan({ cls: "mdsync-plugin-level-custom", text: "Custom" });
		const detail = [
			name === id ? "" : id,
			installed ? "" : "not installed here",
		]
			.filter(Boolean)
			.join(" · ");
		if (detail)
			text.createDiv({ cls: "mdsync-modal-row-detail", text: detail });
		const levelOf = (): EPluginLevel => {
			const levels = choice.levels();
			return Object.hasOwn(levels, id)
				? (levels[id] ?? choice.defaultLevel)
				: choice.defaultLevel;
		};
		const mark = () => custom.toggle(levelOf() !== choice.defaultLevel);
		mark();
		renderSegments(
			row,
			`plugin-level-${id}`,
			PLUGIN_LEVEL_OPTIONS,
			levelOf,
			async (level) => {
				// A computed key stays an own property even for an id like `__proto__`.
				const levels = { ...choice.levels(), [id]: level };
				if (level === choice.defaultLevel) delete levels[id];
				await choice.save(levels);
				mark();
			},
		).el.addClasses(["is-compact", "mdsync-plugin-level"]);
	}
}
