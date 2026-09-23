import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import type { EChangeType } from "@/sync/types";
import { type ChangeAction, changeActionOf } from "./change-action";
import { setIndicatorTooltip } from "./indicator-tooltip";

type ChangeIndicatorClass =
	| "obsync-changed-added"
	| "obsync-changed-modified"
	| "obsync-changed-deleted"
	| "obsync-changed-conflict";

interface PathDecoration {
	change?: ChangeIndicatorClass;
	linkRoot?: string;
	ignored?: boolean;
}

export interface AppliedDecoration {
	key: string;
	target: HTMLElement;
}

const CHANGE_CLASSES: ReadonlyArray<ChangeIndicatorClass> = [
	"obsync-changed-added",
	"obsync-changed-modified",
	"obsync-changed-deleted",
	"obsync-changed-conflict",
];
const CHANGE_CLASS_BY_ACTION: Record<ChangeAction, ChangeIndicatorClass> = {
	add: "obsync-changed-added",
	modify: "obsync-changed-modified",
	delete: "obsync-changed-deleted",
};

export function computeDecorations(
	plugin: PluginHost,
	controller: SyncController,
	directLinks: ReadonlyMap<string, string>,
): Map<string, PathDecoration> {
	const out = new Map<string, PathDecoration>();
	for (const [path, status] of controller.fileDiffs.getChangedPathStatuses()) {
		const cls = classifyStatus(status);
		if (cls) patchDecoration(out, path, { change: cls });
	}
	for (const [path, linkRoot] of directLinks) {
		patchDecoration(out, path, { linkRoot });
	}
	for (const path of plugin.ignoreState.ignoredPaths()) {
		patchDecoration(out, path, { ignored: true });
	}
	return out;
}

export function decorationKey(decoration: PathDecoration): string {
	return JSON.stringify(decoration);
}

export function renderDecoration(
	target: HTMLElement,
	decoration: PathDecoration,
): void {
	if (decoration.change) target.addClass(decoration.change);
	if (decoration.ignored) target.addClass("obsync-explorer-ignored");
	if (decoration.linkRoot) {
		target.addClass("obsync-has-path-badge");
		renderLinkBadge(target, decoration.linkRoot);
	}
}

export function clearDecoration(target: HTMLElement): void {
	for (const cls of CHANGE_CLASSES) target.removeClass(cls);
	target.removeClass("obsync-explorer-ignored");
	target.removeClass("obsync-has-path-badge");
	for (const badge of target.querySelectorAll(".obsync-path-badge")) {
		badge.remove();
	}
}

export function sameStringMap(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false;
	}
	return true;
}

function classifyStatus(
	status: EChangeType | "conflict",
): ChangeIndicatorClass | null {
	if (status === "conflict") return "obsync-changed-conflict";
	const action = changeActionOf(status);
	return action ? CHANGE_CLASS_BY_ACTION[action] : null;
}

function patchDecoration(
	target: Map<string, PathDecoration>,
	path: string,
	patch: PathDecoration,
): void {
	target.set(path, { ...target.get(path), ...patch });
}

function renderLinkBadge(target: HTMLElement, linkRoot: string): void {
	const badge = target.createSpan({
		cls: "obsync-path-badge obsync-link-badge",
	});
	setIcon(badge, "link-2");
	setIndicatorTooltip(badge, `Linked path: ${linkRoot}\nExcluded from sync`);
}
