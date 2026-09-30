import { setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import type { EChangeType } from "@/sync/types";
import { type ChangeAction, changeActionOf } from "@/ui/common";
import { renderPresenceMarks } from "./file-explorer-badges";
import type { PresenceMarks } from "./file-explorer-marks";

type ChangeIndicatorClass =
	| "obsync-changed-added"
	| "obsync-changed-modified"
	| "obsync-changed-deleted"
	| "obsync-changed-conflict";

export interface BaseMarks {
	change?: ChangeIndicatorClass;
	linkRoot?: string;
	ignored?: boolean;
}

export type PathDecoration = BaseMarks & PresenceMarks;

export interface AppliedDecoration {
	decoration: PathDecoration;
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

export function computeBase(
	plugin: PluginHost,
	controller: SyncController,
	directLinks: ReadonlyMap<string, string>,
): Map<string, BaseMarks> {
	const out = new Map<string, BaseMarks>();
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

export function decorationOf(
	base: BaseMarks | undefined,
	marks: PresenceMarks | undefined,
): PathDecoration | undefined {
	return base && marks ? { ...base, ...marks } : (base ?? marks);
}

export function sameDecoration(
	left: PathDecoration,
	right: PathDecoration,
): boolean {
	return (
		left === right ||
		(left.change === right.change &&
			left.linkRoot === right.linkRoot &&
			left.ignored === right.ignored &&
			sameFlat(left.unseen, right.unseen) &&
			sameFlat(left.share, right.share) &&
			sameList(left.people, right.people))
	);
}

export function renderDecoration(
	target: HTMLElement,
	decoration: PathDecoration,
	plugin: PluginHost,
): void {
	if (decoration.change) target.addClass(decoration.change);
	if (decoration.ignored) target.addClass("obsync-explorer-ignored");
	if (
		decoration.linkRoot ||
		decoration.people?.length ||
		decoration.share ||
		decoration.unseen
	) {
		target.addClass("obsync-has-path-badge");
	}
	if (decoration.linkRoot) renderLinkBadge(target, decoration.linkRoot);
	renderPresenceMarks(target, decoration, plugin);
}

export function clearDecoration(target: HTMLElement): void {
	for (const cls of CHANGE_CLASSES) target.removeClass(cls);
	target.removeClass("obsync-explorer-ignored");
	target.removeClass("obsync-has-path-badge");
	for (const badge of target.querySelectorAll(".obsync-path-badge")) {
		badge.remove();
	}
}

function classifyStatus(
	status: EChangeType | "conflict",
): ChangeIndicatorClass | null {
	if (status === "conflict") return "obsync-changed-conflict";
	const action = changeActionOf(status);
	return action ? CHANGE_CLASS_BY_ACTION[action] : null;
}

function patchDecoration(
	target: Map<string, BaseMarks>,
	path: string,
	patch: BaseMarks,
): void {
	target.set(path, { ...target.get(path), ...patch });
}

function sameFlat(left?: object, right?: object): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	const entries = Object.entries(left);
	return (
		entries.length === Object.keys(right).length &&
		entries.every(
			([key, value]) => (right as Record<string, unknown>)[key] === value,
		)
	);
}

function sameList(
	left: readonly object[] = [],
	right: readonly object[] = [],
): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => sameFlat(item, right[index]))
	);
}

function renderLinkBadge(target: HTMLElement, linkRoot: string): void {
	const badge = target.createSpan({
		cls: "obsync-path-badge obsync-link-badge",
		attr: {
			role: "img",
			"aria-label": `Linked path: ${linkRoot}\nExcluded from sync`,
		},
	});
	setIcon(badge, "link-2");
}
