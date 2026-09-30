import { Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redrawOnPhoneChange } from "@/ui/common/phone-change";

const body = {};

class FakeObserver {
	static live = new Set<FakeObserver>();
	observed: { target: unknown; options: unknown } | null = null;

	constructor(private readonly callback: () => void) {}

	observe(target: unknown, options: unknown): void {
		this.observed = { target, options };
		FakeObserver.live.add(this);
	}

	disconnect(): void {
		FakeObserver.live.delete(this);
	}

	mutate(): void {
		this.callback();
	}
}

function bodyClassChanged(): void {
	for (const observer of FakeObserver.live) observer.mutate();
}

function view() {
	const cleanups: Array<() => unknown> = [];
	return {
		register: (cleanup: () => unknown) => void cleanups.push(cleanup),
		unload: () => {
			for (const cleanup of cleanups) cleanup();
		},
	};
}

describe("redrawOnPhoneChange", () => {
	afterEach(() => {
		Platform.isPhone = false;
		FakeObserver.live.clear();
		vi.unstubAllGlobals();
	});

	function setup() {
		vi.stubGlobal("MutationObserver", FakeObserver);
		vi.stubGlobal("document", { body });
		const host = view();
		const redraw = vi.fn();
		redrawOnPhoneChange(host, redraw);
		return { host, redraw };
	}

	it("watches the body class Obsidian flips is-phone on", () => {
		setup();
		const [observer] = FakeObserver.live;
		expect(observer?.observed).toEqual({
			target: body,
			options: { attributes: true, attributeFilter: ["class"] },
		});
	});

	it("redraws once Platform.isPhone has flipped, and only then", () => {
		const { redraw } = setup();
		bodyClassChanged();
		expect(redraw).not.toHaveBeenCalled();
		Platform.isPhone = true;
		bodyClassChanged();
		bodyClassChanged();
		expect(redraw).toHaveBeenCalledTimes(1);
		Platform.isPhone = false;
		bodyClassChanged();
		expect(redraw).toHaveBeenCalledTimes(2);
	});

	it("stops watching when the view unloads", () => {
		const { host, redraw } = setup();
		host.unload();
		expect(FakeObserver.live.size).toBe(0);
		Platform.isPhone = true;
		bodyClassChanged();
		expect(redraw).not.toHaveBeenCalled();
	});
});
