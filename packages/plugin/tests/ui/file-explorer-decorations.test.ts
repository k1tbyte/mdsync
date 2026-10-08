import { ALEX, host, SAM } from "@tests/helpers/explorer-host";
import { Platform, setIcon } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { badgeActivation } from "@/ui/explorer/file-explorer-badges";
import {
	type PathDecoration,
	renderDecoration,
	sameDecoration,
} from "@/ui/explorer/file-explorer-decorations";
import type { ShareMark } from "@/ui/explorer/file-explorer-marks";
import { openManageLinks } from "@/ui/links";

vi.mock("@/ui/links", () => ({ openManageLinks: vi.fn() }));
vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	setIcon: vi.fn(),
}));

const PUBLISHED = {
	path: "notes/published.md",
	count: 1,
	stale: false,
	text: "Shared by link. Click to manage.",
};
const SHARE: ShareMark = { root: "Team", kind: "owned", here: 1 };

describe("comparing decorations", () => {
	const full: PathDecoration = {
		change: "mdsync-changed-added",
		linkRoot: "Team/link",
		ignored: true,
		skipped: "Not synced",
		unseen: { count: 1, file: "Team/a.md" },
		share: SHARE,
		published: PUBLISHED,
		people: [ALEX],
	};
	const differing: [string, PathDecoration][] = [
		["a changed status", { ...full, change: "mdsync-changed-deleted" }],
		["another link", { ...full, linkRoot: "Team/other" }],
		["a lost ignore mark", { ...full, ignored: undefined }],
		["another skip reason", { ...full, skipped: "Not synced either" }],
		["another unseen count", { ...full, unseen: { count: 2 } }],
		["an unseen folder", { ...full, unseen: { count: 1 } }],
		[
			"a share of another kind",
			{ ...full, share: { ...SHARE, kind: "paused" } },
		],
		["a share with another count", { ...full, share: { ...SHARE, here: 2 } }],
		[
			"a share at another root",
			{ ...full, share: { ...SHARE, root: "Other" } },
		],
		["a dropped share", { ...full, share: undefined }],
		[
			"a stale publication",
			{ ...full, published: { ...PUBLISHED, stale: true } },
		],
		["another link count", { ...full, published: { ...PUBLISHED, count: 2 } }],
		[
			"another tooltip",
			{ ...full, published: { ...PUBLISHED, text: "Updated" } },
		],
		[
			"another note",
			{ ...full, published: { ...PUBLISHED, path: "other.md" } },
		],
		["a revoked publication", { ...full, published: undefined }],
		["a person gone idle", { ...full, people: [{ ...ALEX, idle: true }] }],
		["a renamed person", { ...full, people: [{ ...ALEX, name: "Al" }] }],
		[
			"a person at another note",
			{ ...full, people: [{ ...ALEX, note: "Team/z.md" }] },
		],
		["another person joining", { ...full, people: [ALEX, SAM] }],
		["everyone gone", { ...full, people: undefined }],
	];

	it.each(differing)("tells apart %s", (_, other) => {
		expect(sameDecoration(full, other)).toBe(false);
		expect(sameDecoration(other, full)).toBe(false);
	});

	it("takes copies as equal, an empty list as no list", () => {
		const copy: PathDecoration = {
			...full,
			share: { ...SHARE },
			published: { ...PUBLISHED },
			unseen: { count: 1, file: "Team/a.md" },
			people: [{ ...ALEX }],
		};

		expect(sameDecoration(full, copy)).toBe(true);
		expect(sameDecoration({}, { people: [] })).toBe(true);
		expect(sameDecoration({ people: [ALEX] }, { people: [] })).toBe(false);
	});

	it("marks a row with a badge for people only when there are some", () => {
		const addClass = vi.fn();
		const target = { addClass } as unknown as HTMLElement;
		const plugin = {} as PluginHost;

		renderDecoration(target, { people: [] }, plugin);
		expect(addClass).not.toHaveBeenCalled();

		renderDecoration(target, { ignored: true }, plugin);
		expect(addClass).toHaveBeenCalledWith("mdsync-explorer-ignored");
		expect(addClass).not.toHaveBeenCalledWith("mdsync-has-path-badge");
	});
});

class BadgeElement {
	readonly classes = new Set<string>();
	readonly children: BadgeElement[] = [];
	private attributes: Record<string, string> = {};

	constructor(private readonly parent?: BadgeElement) {}

	createSpan({
		cls,
		attr = {},
	}: {
		cls: string;
		attr?: Record<string, string>;
	}) {
		const child = new BadgeElement(this);
		for (const name of cls.split(" ")) child.addClass(name);
		child.attributes = attr;
		this.children.push(child);
		return child;
	}

	addClass(name: string) {
		this.classes.add(name);
	}

	getAttribute(name: string) {
		return this.attributes[name] ?? null;
	}

	closest(selector: string): BadgeElement | null {
		if (this.classes.has(selector.slice(1))) return this;
		return this.parent?.closest(selector) ?? null;
	}
}

function publishedBadge(stale = false) {
	const target = new BadgeElement();
	const plugin = host([], []);
	renderDecoration(
		target as unknown as HTMLElement,
		{ published: { ...PUBLISHED, stale } },
		plugin,
	);
	return { target, plugin, badge: target.children[0] as BadgeElement };
}

describe("published badges", () => {
	beforeEach(() => {
		vi.stubGlobal("Element", BadgeElement);
		vi.mocked(openManageLinks).mockClear();
		vi.mocked(setIcon).mockClear();
	});

	afterEach(() => {
		Platform.isMobile = false;
		vi.unstubAllGlobals();
	});

	it.each([false, true])("renders an accessible globe, stale %s", (stale) => {
		const { target, badge } = publishedBadge(stale);

		expect(target.classes.has("mdsync-has-path-badge")).toBe(true);
		expect(badge.classes.has("mdsync-path-badge")).toBe(true);
		expect(badge.classes.has("mdsync-published-badge")).toBe(true);
		expect(badge.classes.has("is-stale")).toBe(stale);
		expect(badge.getAttribute("role")).toBe("button");
		expect(badge.getAttribute("tabindex")).toBe("0");
		expect(badge.getAttribute("aria-label")).toBe(PUBLISHED.text);
		expect(badge.getAttribute("data-path")).toBe(PUBLISHED.path);
		expect(setIcon).toHaveBeenCalledWith(badge.children[0], "globe");
	});

	it.each([
		[false, "click", undefined],
		[false, "keydown", "Enter"],
		[false, "keydown", " "],
		[true, "click", undefined],
	] as const)("opens management on mobile %s, %s %s", (mobile, type, key) => {
		Platform.isMobile = mobile;
		const { plugin, badge } = publishedBadge();
		const event = {
			type,
			...(key ? { key } : {}),
			target: badge.children[0],
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		};

		badgeActivation(plugin)(event as unknown as MouseEvent | KeyboardEvent);

		expect(openManageLinks).toHaveBeenCalledWith(plugin, PUBLISHED.path);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(event.stopPropagation).toHaveBeenCalledOnce();
	});

	it("leaves unrelated keys alone", () => {
		const { plugin, badge } = publishedBadge();
		const event = {
			type: "keydown",
			key: "ArrowDown",
			target: badge,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		};

		badgeActivation(plugin)(event as unknown as KeyboardEvent);

		expect(openManageLinks).not.toHaveBeenCalled();
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(event.stopPropagation).not.toHaveBeenCalled();
	});
});
