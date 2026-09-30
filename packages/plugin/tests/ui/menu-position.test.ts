import { FakeMenu } from "@tests/helpers/fake-menu";
import { describe, expect, it } from "vitest";

import { showMenuAt } from "@/ui/live/menu-position";

function anchor(top: number, isShown = true) {
	return {
		isShown: () => isShown,
		getBoundingClientRect: () => ({ left: 40, top, bottom: top + 20 }),
		win: { innerHeight: 800 },
		doc: "its-document",
	} as unknown as HTMLElement;
}

const view = (doc: string) =>
	({
		getBoundingClientRect: () => ({
			left: 100,
			top: 30,
			width: 400,
			height: 300,
		}),
		doc,
	}) as unknown as HTMLElement;

function open(target?: HTMLElement, within = view("main")) {
	const menu = new FakeMenu();
	showMenuAt(menu as never, target, within);
	return menu.at;
}

describe("where a menu opens", () => {
	it("goes under an anchor in the top half of its window", () => {
		expect(open(anchor(50))?.position).toEqual({ x: 40, y: 70 });
	});

	it("goes over an anchor in the lower half, where it would not fit below", () => {
		expect(open(anchor(780))?.position).toEqual({ x: 40, y: 780 });
	});

	it("opens in the anchor's own window, a pop-out included", () => {
		expect(open(anchor(50))?.doc).toBe("its-document");
	});

	it("opens in the upper middle of the view it is about, in that view's window, without a visible anchor", () => {
		const expected = { position: { x: 300, y: 130 }, doc: "the-popout" };

		expect(open(undefined, view("the-popout"))).toEqual(expected);
		expect(open(anchor(780, false), view("the-popout"))).toEqual(expected);
	});
});
