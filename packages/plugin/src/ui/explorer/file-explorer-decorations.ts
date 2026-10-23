import { setIcon } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import type { EChangeType } from "@/sync/types";
import {
	type ChangeAction,
	changeActionOf,
	skippedFiles,
	skippedText,
} from "@/ui/common";

import { renderPresenceMarks } from "./file-explorer-badges";
import type { PresenceMarks } from "./file-explorer-marks";

type ChangeKind = ChangeAction | "move" | "conflict";

export interface ChangeMark {
	kind: ChangeKind;
	/** Made elsewhere: a pull brings it. */
	incoming: boolean;
}

export interface BaseMarks {
	change?: ChangeMark;
	linkRoot?: string;
	/** Only the topmost ignored row carries the mark; the rows below are just dimmed. */
	ignored?: "root" | "below";
	/** Why the last compare left it out. */
	skipped?: string;
}

export type PathDecoration = BaseMarks & PresenceMarks;

export interface AppliedDecoration {
	decoration: PathDecoration;
	target: HTMLElement;
}

const CHANGE_KINDS: readonly ChangeKind[] = [
	"add",
	"modify",
	"delete",
	"move",
	"conflict",
];
const CHANGE_TEXT: Record<ChangeAction | "move", string> = {
	add: "Added",
	modify: "Edited",
	delete: "Deleted",
	move: "Moved",
};
const TARGET_CLASSES = [
	"mdsync-changed",
	...CHANGE_KINDS.map((kind) => `mdsync-changed-${kind}`),
	"mdsync-explorer-ignored",
	"mdsync-explorer-skipped",
	"mdsync-share-root",
	"mdsync-has-path-badge",
];

export function computeBase(
	plugin: PluginHost,
	controller: SyncController,
	directLinks: ReadonlyMap<string, string>,
): Map<string, BaseMarks> {
	const out = new Map<string, BaseMarks>();
	const statuses = controller.fileDiffs.getChangedPathStatuses();
	for (const [path, status] of statuses) {
		const change = changeMarkOf(status);
		if (change) patchDecoration(out, path, { change });
	}
	// The move shows on the row on disk: its new path when made here, its old one when made elsewhere.
	for (const move of controller.getSnapshot().result?.diff.moves ?? []) {
		const incoming = move.side === "remote";
		const path = incoming ? move.from : move.to;
		if (statuses.get(path) === "conflict") continue;
		patchDecoration(out, path, { change: { kind: "move", incoming } });
	}
	for (const [path, linkRoot] of directLinks) {
		patchDecoration(out, path, { linkRoot });
	}
	const ignored = plugin.ignoreState.ignoredPaths();
	for (const path of ignored) {
		const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
		patchDecoration(out, path, {
			ignored: ignored.has(parent) ? "below" : "root",
		});
	}
	for (const file of skippedFiles(controller)) {
		const skipped = skippedText(file, plugin.settings.maxFileBytes);
		patchDecoration(out, file.path, { skipped });
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
		(sameFlat(left.change, right.change) &&
			left.linkRoot === right.linkRoot &&
			left.ignored === right.ignored &&
			left.skipped === right.skipped &&
			sameFlat(left.unseen, right.unseen) &&
			sameFlat(left.share, right.share) &&
			sameFlat(left.published, right.published) &&
			sameList(left.people, right.people))
	);
}

export function renderDecoration(
	target: HTMLElement,
	decoration: PathDecoration,
	plugin: PluginHost,
): void {
	const { change, ignored, skipped, linkRoot, share } = decoration;
	if (change) {
		target.addClass("mdsync-changed", `mdsync-changed-${change.kind}`);
	}
	if (ignored) target.addClass("mdsync-explorer-ignored");
	if (skipped) target.addClass("mdsync-explorer-skipped");
	// Colours the guide down its notes.
	if (share && share.kind !== "paused") target.addClass("mdsync-share-root");
	if (skipped) {
		renderIconBadge(target, "mdsync-skip-badge", "cloud-off", skipped);
	}
	if (ignored === "root") {
		renderIconBadge(
			target,
			"mdsync-ignore-badge",
			"eye-off",
			"Ignored\nExcluded from sync",
		);
	}
	if (linkRoot) {
		renderIconBadge(
			target,
			"mdsync-link-badge",
			"link-2",
			`Linked path: ${linkRoot}\nExcluded from sync`,
		);
	}
	renderPresenceMarks(target, decoration, plugin);
	if (change) renderChangeMark(target, change);
	if (target.querySelector(".mdsync-path-badge")) {
		target.addClass("mdsync-has-path-badge");
	}
}

export function clearDecoration(target: HTMLElement): void {
	target.removeClass(...TARGET_CLASSES);
	for (const badge of target.querySelectorAll(".mdsync-path-badge")) {
		badge.remove();
	}
}

function changeMarkOf(status: EChangeType | "conflict"): ChangeMark | null {
	if (status === "conflict") return { kind: "conflict", incoming: false };
	const kind = changeActionOf(status);
	return kind ? { kind, incoming: status.startsWith("remote") } : null;
}

/** A dot for a change made here, an arrow for one to pull: the name takes its colour. */
function renderChangeMark(
	target: HTMLElement,
	{ kind, incoming }: ChangeMark,
): void {
	if (kind === "conflict") {
		renderIconBadge(
			target,
			"mdsync-change-mark",
			"triangle-alert",
			"Conflict: changed here and elsewhere",
		);
		return;
	}
	const label = `${CHANGE_TEXT[kind]} ${incoming ? "elsewhere, not pulled yet" : "here, not pushed yet"}`;
	if (incoming) {
		renderIconBadge(target, "mdsync-change-mark", "arrow-down", label);
		return;
	}
	target.createSpan({
		cls: "mdsync-path-badge mdsync-change-mark mdsync-dot",
		attr: { role: "img", "aria-label": label },
	});
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
		entries.every(([key, value]) =>
			sameValue(value, (right as Record<string, unknown>)[key]),
		)
	);
}

/** A person's `devices` is built anew with every presence change. */
function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	return (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((item, index) => item === right[index])
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

function renderIconBadge(
	target: HTMLElement,
	cls: string,
	icon: string,
	label: string,
): void {
	const badge = target.createSpan({
		cls: `mdsync-path-badge ${cls}`,
		attr: { role: "img", "aria-label": label },
	});
	setIcon(badge, icon);
}
