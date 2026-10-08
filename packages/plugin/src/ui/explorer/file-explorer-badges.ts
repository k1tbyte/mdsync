import { Notice, Platform, setIcon } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { describePeople, lastEditLabel, renderAvatarStack } from "@/ui/common";
import { openManageLinks } from "@/ui/links";
import { openShareWindow } from "@/ui/shares/share-window";

import type {
	PresenceMarks,
	PublishedMark,
	ShareKind,
	ShareMark,
	UnseenMark,
} from "./file-explorer-marks";

const SHARE_ICONS: Record<ShareKind, string> = {
	owned: "share-2",
	joined: "users",
	"read-only": "eye",
	paused: "pause",
};
const SHARE_TOOLTIPS: Record<ShareKind, string> = {
	owned: "Shared folder: you invite who can open it",
	joined: "Shared with you",
	"read-only": "Shared with you, read-only",
	paused: "Shared folder, paused on this device",
};
const SHARE_ROOT_ATTR = "data-share-root";
const SHARE_BADGE = ".mdsync-share-badge";
const PUBLISHED_BADGE = ".mdsync-published-badge";
const TAP_BADGES =
	".mdsync-people-badge, .mdsync-unseen-dot, .mdsync-skip-badge";
const TIP_MS = 4000;

/** Read here, not while computing marks: a pass runs on every sync event. */
export function renderPresenceMarks(
	target: HTMLElement,
	marks: PresenceMarks,
	plugin: PluginHost,
): void {
	if (marks.unseen) {
		target.createSpan({
			cls: "mdsync-path-badge mdsync-unseen-dot",
			attr: { role: "img", "aria-label": unseenTooltip(plugin, marks.unseen) },
		});
	}
	if (marks.people && marks.people.length > 0) {
		const badge = target.createSpan({
			cls: "mdsync-path-badge mdsync-people-badge",
			attr: {
				role: "img",
				"aria-label": `Here: ${describePeople(marks.people)}`,
			},
		});
		renderAvatarStack(badge, marks.people);
	}
	if (marks.share) renderShareBadge(target, marks.share);
	if (marks.published) renderPublishedBadge(target, marks.published);
}

/** Action badges open management; other badges show a tooltip on phones. */
export function badgeActivation(
	plugin: PluginHost,
): (event: MouseEvent | KeyboardEvent) => void {
	let tip: Notice | null = null;
	return (event) => {
		if ("key" in event && event.key !== "Enter" && event.key !== " ") return;
		if (!(event.target instanceof Element)) return;
		const share = event.target.closest(SHARE_BADGE);
		const published = event.target.closest(PUBLISHED_BADGE);
		const mark =
			!share && !published && event.type === "click" && Platform.isMobile
				? event.target.closest(TAP_BADGES)
				: null;
		if (!share && !published && !mark) return;
		event.preventDefault();
		event.stopPropagation();
		if (mark) {
			tip?.hide();
			tip = new Notice(mark.getAttribute("aria-label") ?? "", TIP_MS);
			return;
		}
		if (published) {
			openManageLinks(plugin, published.getAttribute("data-path") ?? "");
			return;
		}
		const record = plugin.spaces.shareAt(
			share?.getAttribute(SHARE_ROOT_ATTR) ?? "",
		);
		if (record) openShareWindow(plugin, record);
	};
}

function unseenTooltip(
	plugin: PluginHost,
	{ count, file }: UnseenMark,
): string {
	if (file) return lastEditLabel(plugin, file) ?? "Changed by someone else";
	return `${count} changed by others since you opened them`;
}

function renderPublishedBadge(
	target: HTMLElement,
	published: PublishedMark,
): void {
	const badge = target.createSpan({
		cls: "mdsync-path-badge mdsync-published-badge",
		attr: {
			"data-path": published.path,
			role: "button",
			tabindex: "0",
			"aria-label": published.text,
		},
	});
	if (published.stale) badge.addClass("is-stale");
	setIcon(badge.createSpan({ cls: "mdsync-published-icon" }), "globe");
}

function renderShareBadge(target: HTMLElement, share: ShareMark): void {
	const lines = ["Manage sharing", SHARE_TOOLTIPS[share.kind]];
	if (share.here > 0) lines.push(`${share.here} in its notes now`);
	const badge = target.createSpan({
		cls: `mdsync-path-badge mdsync-share-badge is-${share.kind}`,
		attr: {
			[SHARE_ROOT_ATTR]: share.root,
			role: "button",
			tabindex: "0",
			"aria-label": lines.join("\n"),
		},
	});
	setIcon(
		badge.createSpan({ cls: "mdsync-share-icon" }),
		SHARE_ICONS[share.kind],
	);
	if (share.here > 0) {
		badge.addClass("has-people");
		badge.createSpan({ cls: "mdsync-share-count", text: String(share.here) });
	}
}
