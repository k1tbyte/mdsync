import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { badgeActivation } from "@/ui/explorer/file-explorer-presence";
import { openShareWindow } from "@/ui/shares/share-window";

const notices: { text: string; duration: number; hide: () => void }[] = [];

vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	Notice: class {
		hide = vi.fn();
		constructor(
			readonly text: string,
			readonly duration: number,
		) {
			notices.push(this);
		}
	},
}));
vi.mock("@/ui/shares/share-window", () => ({
	shareAt: (_plugin: unknown, root: string) => ({ id: "s", root }),
	openShareWindow: vi.fn(),
}));

class FakeElement {
	constructor(
		private readonly classes: string[],
		private readonly attrs: Record<string, string> = {},
	) {}
	closest(selector: string): FakeElement | null {
		return this.matches(selector) ? this : null;
	}
	matches(selector: string): boolean {
		return selector
			.split(",")
			.some((each) => this.classes.includes(each.trim().slice(1)));
	}
	getAttribute(name: string): string | null {
		return this.attrs[name] ?? null;
	}
}

const plugin = {} as PluginHost;
const badge = (...classes: string[]) =>
	new FakeElement(["obsync-path-badge", ...classes], {
		"aria-label": "Here: Alex, Sam (away)",
		"data-share-root": "Team",
	});
const share = badge("obsync-share-badge");
const people = badge("obsync-people-badge");
const dot = badge("obsync-unseen-dot");
const link = badge("obsync-link-badge");

function event(type: "click" | "keydown", target: FakeElement, key?: string) {
	return {
		type,
		...(key === undefined ? {} : { key }),
		target,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
	} as unknown as MouseEvent & KeyboardEvent;
}

const handled = (e: MouseEvent) =>
	vi.mocked(e.stopPropagation).mock.calls.length > 0;

function tap(target: FakeElement) {
	const e = event("click", target);
	badgeActivation(plugin)(e);
	return e;
}

beforeEach(() => {
	vi.stubGlobal("Element", FakeElement);
	notices.length = 0;
	vi.mocked(openShareWindow).mockClear();
	Object.assign(Platform, { isMobile: false, isPhone: false, isTablet: false });
});

afterEach(() => vi.unstubAllGlobals());

describe("activating a badge in the file explorer", () => {
	it("opens the share's window from a share badge, without folding the folder", () => {
		const e = tap(share);

		expect(openShareWindow).toHaveBeenCalledWith(plugin, {
			id: "s",
			root: "Team",
		});
		expect(handled(e)).toBe(true);
		expect(e.preventDefault).toHaveBeenCalled();
	});

	it("opens it from the keyboard with Enter or Space only", () => {
		const activate = badgeActivation(plugin);

		activate(event("keydown", share, "a"));
		expect(openShareWindow).not.toHaveBeenCalled();

		activate(event("keydown", share, "Enter"));
		activate(event("keydown", share, " "));
		expect(openShareWindow).toHaveBeenCalledTimes(2);
	});

	it.each([
		["a people badge", people],
		["an unseen dot", dot],
	])(
		"says what the tooltip says when tapping %s on a touch device",
		(_name, target) => {
			Platform.isMobile = true;

			const e = tap(target);

			expect(notices.map(({ text }) => text)).toEqual([
				"Here: Alex, Sam (away)",
			]);
			expect(handled(e)).toBe(true);
		},
	);

	it("does the same on a tablet, where sizing follows the same touch rule", () => {
		Object.assign(Platform, { isMobile: true, isTablet: true });

		tap(people);

		expect(notices).toHaveLength(1);
	});

	it("replaces the previous notice instead of stacking a new one over it", () => {
		Platform.isMobile = true;
		const activate = badgeActivation(plugin);

		activate(event("click", people));
		activate(event("click", dot));

		expect(notices).toHaveLength(2);
		expect(notices[0]?.hide).toHaveBeenCalledTimes(1);
		expect(notices[1]?.hide).not.toHaveBeenCalled();
	});

	it("leaves a people badge and a dot to the row on a desktop, where they have a tooltip", () => {
		const onPeople = tap(people);
		const onDot = tap(dot);

		expect(notices).toEqual([]);
		expect([handled(onPeople), handled(onDot)]).toEqual([false, false]);
	});

	it("lets a tap on a link badge through to the row, as it has no enlarged target", () => {
		Platform.isMobile = true;

		const e = tap(link);

		expect(notices).toEqual([]);
		expect(handled(e)).toBe(false);
		expect(e.preventDefault).not.toHaveBeenCalled();
	});

	it("lets a key pressed on a people badge through: only a share badge takes the keyboard", () => {
		Platform.isMobile = true;
		const e = event("keydown", people, "Enter");

		badgeActivation(plugin)(e);

		expect(notices).toEqual([]);
		expect(handled(e)).toBe(false);
	});

	it("leaves everything else in a row alone", () => {
		Platform.isMobile = true;

		const e = tap(new FakeElement(["nav-file-title"]));

		expect(notices).toEqual([]);
		expect(e.preventDefault).not.toHaveBeenCalled();
	});
});
