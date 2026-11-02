import { setIcon } from "obsidian";
import { formatBytes, pluralize } from "@/core/shared";
import {
	appendIconButton,
	appendLabeledButton,
	makeActivatable,
	onLongPress,
	renderPath,
} from "@/core/ui";
import type { Resolution } from "@/features/sync";
import { STATUS_CLASSES, STATUS_LETTERS } from "../changes/row-formatter";
import type { RowPager } from "../history/row-pager";
import { renderDelta } from "../row-parts";
import { type SessionRow, touches } from "./session-rows";
import type { TimelineFileRow, TimelineRow } from "./timeline-rows";

const PERIOD_CAPTION: Partial<Record<Resolution, string>> = {
	"10m": "Last version of every 10 minutes",
	"1h": "Last version of each hour",
	"1d": "Last version of each day",
	"1w": "Last version of each week",
};

export interface CardContext {
	/** Lowercase path filter, empty for none. */
	query: string;
	selected: string | null;
	opening: string | null;
	isOpen(key: string): boolean;
	toggle(key: string): void;
	pager(key: string): RowPager;
	rerender(): void;
	sessionMenu(event: MouseEvent, row: SessionRow): void;
	versionMenu(event: MouseEvent, row: TimelineRow): void;
	fileMenu(event: MouseEvent, owner: string, file: TimelineFileRow): void;
	openFile(owner: string, file: TimelineFileRow): void;
}

interface Heading {
	title: string;
	meta: string | null;
	tooltip: string;
	counts: string | null;
	tally: TimelineRow["tally"];
	netDelta: number | null;
	pinned: boolean;
	isHead: boolean;
}

export function renderSessionCard(
	parent: HTMLElement,
	row: SessionRow,
	ctx: CardContext,
): void {
	const card = parent.createDiv({ cls: "mdsync-timeline-card" });
	renderHead(card, row.key, row, ctx, (event) => ctx.sessionMenu(event, row));
	if (!ctx.isOpen(row.key)) return;
	const body = card.createDiv({ cls: "mdsync-timeline-files" });
	const versions = ctx.query
		? row.versions.filter((version) => touches(version, ctx.query))
		: row.versions;
	if (!row.everyPush) {
		body.createDiv({
			cls: "mdsync-timeline-caption",
			text: (row.res && PERIOD_CAPTION[row.res]) ?? "",
		});
		renderVersions(body, row.key, versions, ctx);
		return;
	}
	renderFiles(body, row.key, row.files, ctx);
	if (row.versions.length < 2) return;
	const allKey = `all:${row.key}`;
	const all = ctx.isOpen(allKey);
	const more = appendLabeledButton(
		body,
		all ? "chevron-up" : "chevron-down",
		all
			? "Hide pushes"
			: `Show all ${pluralize(row.versions.length, "push", "pushes")}`,
		() => ctx.toggle(allKey),
	);
	more.addClass("mdsync-timeline-more");
	more.setAttr("data-timeline-focus", allKey);
	if (all) renderVersions(body, row.key, versions, ctx);
}

function renderVersions(
	parent: HTMLElement,
	owner: string,
	versions: readonly TimelineRow[],
	ctx: CardContext,
): void {
	const pager = ctx.pager(`versions:${owner}`);
	for (const version of pager.slice(versions))
		renderVersion(parent, version, ctx);
	pager.render(parent, versions.length, ctx.rerender);
}

function renderVersion(
	parent: HTMLElement,
	row: TimelineRow,
	ctx: CardContext,
): void {
	const key = `v:${row.snapshotId}`;
	const item = parent.createDiv({ cls: "mdsync-timeline-version" });
	renderHead(item, key, row, ctx, (event) => ctx.versionMenu(event, row));
	if (ctx.isOpen(key)) renderFiles(item, key, row.files, ctx);
}

function renderHead(
	parent: HTMLElement,
	key: string,
	row: Heading,
	ctx: CardContext,
	menu: (event: MouseEvent) => void,
): void {
	const open = ctx.isOpen(key);
	const head = parent.createDiv({ cls: "mdsync-timeline-head" });
	head.setAttr("data-timeline-focus", key);
	head.setAttr("aria-expanded", String(open));
	// The meta is cut short in a narrow pane; the tooltip keeps all of it.
	const label = [row.title, row.tooltip, row.meta].filter(Boolean).join(" · ");
	makeActivatable(head, label, () => ctx.toggle(key));
	setIcon(
		head.createSpan({ cls: "mdsync-timeline-icon" }),
		open ? "chevron-down" : "chevron-right",
	);
	const copy = head.createDiv({ cls: "mdsync-timeline-copy" });
	const title = copy.createDiv({ cls: "mdsync-timeline-title" });
	title.createSpan({ cls: "mdsync-history-row-title", text: row.title });
	if (row.isHead) title.createSpan({ cls: "mdsync-pill", text: "Latest" });
	if (row.pinned) {
		const pin = title.createSpan({ cls: "mdsync-history-pin" });
		setIcon(pin, "pin");
		pin.setAttr("aria-label", "Pinned version");
	}
	const meta = copy.createDiv({
		cls: "mdsync-history-row-meta mdsync-timeline-meta",
	});
	if (row.meta)
		meta.createSpan({ cls: "mdsync-timeline-device", text: row.meta });
	if (!row.tally) meta.createSpan({ text: "Change record unavailable" });
	else {
		const chips = meta.createSpan({ cls: "mdsync-timeline-chips" });
		if (row.counts) chips.setAttr("aria-label", row.counts);
		for (const [action, count] of row.tally) {
			chips.createSpan({
				cls: `mdsync-count-chip ${STATUS_CLASSES[action]}`,
				text: `${STATUS_LETTERS[action]} ${count}`,
			});
		}
	}
	if (row.netDelta) renderDelta(meta, row.netDelta, "mdsync-timeline-net");
	const actions = head.createDiv({ cls: "mdsync-timeline-actions" });
	const more = appendIconButton(actions, "ellipsis", "Actions", (event) => {
		event.stopPropagation();
		menu(event);
	});
	more.setAttr("data-timeline-focus", `${key}:menu`);
	head.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		menu(event);
	});
}

function renderFiles(
	parent: HTMLElement,
	owner: string,
	all: TimelineFileRow[] | null,
	ctx: CardContext,
): void {
	const list = parent.createDiv({ cls: "mdsync-timeline-file-list" });
	const files = all?.filter((file) =>
		file.path.toLowerCase().includes(ctx.query),
	);
	if (!files || files.length === 0) {
		list.createDiv({
			cls: "mdsync-status-line",
			text: files
				? "No file changes here."
				: "The change record for this push is unavailable.",
		});
		return;
	}
	const pager = ctx.pager(owner);
	for (const file of pager.slice(files)) renderFile(list, owner, file, ctx);
	pager.render(list, files.length, ctx.rerender);
}

function renderFile(
	parent: HTMLElement,
	owner: string,
	file: TimelineFileRow,
	ctx: CardContext,
): void {
	const key = JSON.stringify([owner, file.path]);
	const item = parent.createDiv({
		cls: "mdsync-file-row mdsync-timeline-file",
	});
	item.toggleClass("is-deleted", file.action === "delete");
	item.setAttr("data-timeline-focus", key);
	item.toggleClass("is-active", ctx.selected === key);
	item.toggleClass("is-opening", ctx.opening === key);
	if (ctx.selected === key) item.setAttr("aria-current", "true");
	if (ctx.opening === key) item.setAttr("aria-busy", "true");
	// Before makeActivatable: the hold has to swallow its own trailing click.
	onLongPress(item, (event) => ctx.fileMenu(event, owner, file));
	makeActivatable(item, file.path, () => ctx.openFile(owner, file));
	renderPath(item, file.path);
	// What a change moved; an addition, a deletion or an even change shows its size.
	if (file.sizeDelta) renderDelta(item, file.sizeDelta, "mdsync-timeline-size");
	else
		item.createSpan({
			cls: "mdsync-timeline-size",
			text: formatBytes(file.size),
		});
	item.createSpan({
		cls: `mdsync-file-status ${STATUS_CLASSES[file.action]}`,
		text: STATUS_LETTERS[file.action],
	});
	const actions = item.createDiv({ cls: "mdsync-timeline-actions" });
	const more = appendIconButton(
		actions,
		"ellipsis",
		`Actions for ${file.path}`,
		(event) => {
			event.stopPropagation();
			ctx.fileMenu(event, owner, file);
		},
	);
	more.setAttr("data-timeline-focus", `${key}:menu`);
	item.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		ctx.fileMenu(event, owner, file);
	});
}
