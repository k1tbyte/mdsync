import { MarkdownView, type Plugin, setIcon } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { revealInFileExplorer } from "@/ui/common/obsidian-helpers";
import { createSymlinkDetector, type SymlinkDetector } from "@/vault/symlinks";
import type { IndicatorHandle } from "./indicator-handle";
import { setIndicatorTooltip } from "./indicator-tooltip";

export function registerFileContextIndicators(
	plugin: Plugin & PluginHost,
): IndicatorHandle {
	const root = plugin.addStatusBarItem();
	root.addClass("obsync-file-context", "obsync-hidden");
	let actions: HTMLElement[] = [];
	let revealPath: string | null = null;
	let contextView: MarkdownView | null = null;
	let detector: SymlinkDetector = createDetector(plugin);
	let detectorEnabled = plugin.settings.ignoreSymlinks;
	let enabled = false;
	let disposed = false;
	let renderFrame: number | null = null;

	makeInteractive(root, () => {
		if (revealPath) void revealInFileExplorer(plugin.app, revealPath);
	});

	const clearActions = (): void => {
		for (const action of actions) action.remove();
		actions = [];
	};

	const render = (): void => {
		if (!enabled || disposed) return;
		clearActions();
		root.empty();
		revealPath = null;
		if (detectorEnabled !== plugin.settings.ignoreSymlinks) {
			detectorEnabled = plugin.settings.ignoreSymlinks;
			detector = createDetector(plugin);
		}

		// Keep the last markdown view when clicking the file explorer.
		const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) contextView = activeView;
		if (contextView && !contextView.containerEl.isConnected) {
			contextView = null;
		}
		const view = contextView;
		const file = view?.file ?? plugin.app.workspace.getActiveFile();
		if (!file) {
			root.addClass("obsync-hidden");
			return;
		}
		const linkRoot = detector.findLink(file.path);
		const ignoredLocally = plugin.ignoreState.isIgnoredLocally(file.path);
		const ignoredGlobally = plugin.ignoreState.isIgnoredGlobally(file.path);
		const ignored = ignoredLocally || ignoredGlobally;
		if (!linkRoot && !ignored) {
			root.addClass("obsync-hidden");
			return;
		}
		root.removeClass("obsync-hidden");
		revealPath = linkRoot ?? (ignored ? file.path : null);

		if (linkRoot) {
			const tooltip = `Linked via ${linkRoot}\nExcluded from sync`;
			const chip = root.createSpan({
				cls: "obsync-context-chip obsync-link-context",
			});
			setIcon(chip, "link-2");
			chip.createSpan({ text: `Linked via ${linkRoot}` });
			setIndicatorTooltip(chip, tooltip);
			if (view) {
				const action = view.addAction("link-2", tooltip, () => {
					void revealInFileExplorer(plugin.app, linkRoot);
				});
				action.addClass("obsync-link-context");
				setIndicatorTooltip(action, tooltip);
				actions.push(action);
			}
		}

		if (ignored) {
			const scope = ignoredLocally
				? ignoredGlobally
					? "on this machine and globally"
					: "on this machine"
				: "globally";
			const tooltip = `Ignored ${scope}\nExcluded from sync`;
			const chip = root.createSpan({
				cls: "obsync-context-chip obsync-ignored-context",
			});
			setIcon(chip, "eye-off");
			chip.createSpan({ text: "Ignored" });
			setIndicatorTooltip(chip, tooltip);
			if (view) {
				const action = view.addAction("eye-off", tooltip, () => {
					void revealInFileExplorer(plugin.app, file.path);
				});
				action.addClass("obsync-ignored-context");
				setIndicatorTooltip(action, tooltip);
				actions.push(action);
			}
		}
	};

	const schedule = (): void => {
		if (!enabled || disposed || renderFrame !== null) return;
		renderFrame = window.requestAnimationFrame(() => {
			renderFrame = null;
			if (!enabled || disposed) return;
			render();
		});
	};

	const resetDetector = (): void => {
		detectorEnabled = plugin.settings.ignoreSymlinks;
		detector = createDetector(plugin);
		schedule();
	};

	plugin.registerEvent(plugin.app.workspace.on("file-open", schedule));
	plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", schedule));
	// Re-add chip and action after layout changes drop them.
	plugin.registerEvent(plugin.app.workspace.on("layout-change", schedule));
	plugin.registerEvent(plugin.app.vault.on("create", resetDetector));
	plugin.registerEvent(plugin.app.vault.on("delete", resetDetector));
	plugin.registerEvent(plugin.app.vault.on("rename", resetDetector));
	plugin.register(plugin.ignoreState.subscribe(schedule));
	plugin.register(() => {
		disposed = true;
		if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
		clearActions();
		root.remove();
	});
	plugin.app.workspace.onLayoutReady(schedule);

	return {
		refresh(nextEnabled) {
			enabled = nextEnabled;
			if (!enabled) {
				if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
				renderFrame = null;
				clearActions();
				root.empty();
				root.addClass("obsync-hidden");
				return;
			}
			resetDetector();
		},
	};
}

function createDetector(plugin: Plugin & PluginHost): SymlinkDetector {
	return createSymlinkDetector(
		plugin.app.vault.adapter,
		plugin.settings.ignoreSymlinks,
	);
}

function makeInteractive(target: HTMLElement, activate: () => void): void {
	target.setAttr("role", "button");
	target.setAttr("tabindex", "0");
	target.addEventListener("click", activate);
	target.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		activate();
	});
}
