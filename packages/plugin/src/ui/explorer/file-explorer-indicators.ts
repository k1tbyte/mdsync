import type { Plugin } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import {
	readFileExplorer,
	readFileExplorerContainer,
} from "./file-explorer-api";
import { badgeActivation } from "./file-explorer-badges";
import type { IndicatorHandle } from "./indicator-handle";
import { LinkScan } from "./link-scan";
import { RowDecorator } from "./row-decorator";

export function registerFileExplorerIndicators(
	plugin: Plugin & PluginHost,
	controller: SyncController,
): IndicatorHandle {
	const decorator = new RowDecorator(plugin, controller);
	let indicators = false;
	let disposed = false;
	let renderFrame: number | null = null;
	let rowsChanged = false;
	let observer: MutationObserver | null = null;
	let observedContainer: HTMLElement | null = null;
	const links = new LinkScan(plugin.app.vault.adapter, {
		enabled: () => plugin.settings.ignoreSymlinks,
		explorer: () =>
			indicators ? readFileExplorer(plugin.app.workspace) : null,
		linksChanged: () => schedule(),
	});

	const apply = (): void => {
		if (disposed) return;
		const explorer = readFileExplorer(plugin.app.workspace);
		if (!explorer) return;
		if (links.followSetting()) rowsChanged = true;
		decorator.apply(explorer, links.links, indicators, rowsChanged);
	};

	const schedule = (scanLinks = false): void => {
		if (disposed) return;
		rowsChanged ||= scanLinks;
		if (renderFrame !== null) return;
		renderFrame = window.requestAnimationFrame(() => {
			renderFrame = null;
			if (disposed) return;
			apply();
			if (rowsChanged) {
				rowsChanged = false;
				links.scan();
			}
		});
	};

	const resetLinks = (): void => {
		if (disposed) return;
		links.reset();
		schedule(true);
	};

	const observeExplorer = (): void => {
		if (disposed) return;
		const container = readFileExplorerContainer(plugin.app.workspace);
		if (container === observedContainer) return;
		observer?.disconnect();
		observedContainer = container;
		if (!container) return;
		observer = new MutationObserver((records) => {
			if (hasExternalMutation(records)) schedule(true);
		});
		observer.observe(container, { childList: true, subtree: true });
	};

	plugin.register(() => {
		disposed = true;
		if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
		links.stop();
		observer?.disconnect();
		decorator.clear();
	});

	const unsub = controller.subscribe(() => schedule());
	plugin.register(unsub);
	plugin.register(
		plugin.ignoreState.subscribe(() => {
			decorator.ignoredChanged();
			schedule();
		}),
	);
	plugin.register(plugin.realtime.people.subscribe(() => schedule()));
	plugin.register(plugin.unseen.subscribe(() => schedule()));
	// Capturing: the explorer would fold the folder before a bubbling handler ran.
	const onBadge = badgeActivation(plugin);
	for (const type of ["click", "keydown"] as const) {
		plugin.registerDomEvent(document, type, onBadge, { capture: true });
	}
	plugin.registerEvent(plugin.app.vault.on("create", resetLinks));
	plugin.registerEvent(plugin.app.vault.on("delete", resetLinks));
	plugin.registerEvent(plugin.app.vault.on("rename", resetLinks));

	plugin.registerEvent(
		plugin.app.workspace.on("layout-change", () => {
			observeExplorer();
			schedule(true);
		}),
	);
	plugin.app.workspace.onLayoutReady(() => {
		observeExplorer();
		schedule(true);
	});

	return {
		refresh(showIndicators) {
			indicators = showIndicators;
			observeExplorer();
			resetLinks();
		},
	};
}

function hasExternalMutation(records: MutationRecord[]): boolean {
	for (const record of records) {
		if (
			record.target instanceof Element &&
			record.target.closest(".obsync-path-badge")
		) {
			continue;
		}
		const nodes = [...record.addedNodes, ...record.removedNodes];
		if (nodes.length === 0 || nodes.some((node) => !isIndicatorNode(node))) {
			return true;
		}
	}
	return false;
}

function isIndicatorNode(node: Node): boolean {
	return (
		node instanceof Element &&
		(node.matches(".obsync-path-badge") ||
			node.closest(".obsync-path-badge") !== null)
	);
}
