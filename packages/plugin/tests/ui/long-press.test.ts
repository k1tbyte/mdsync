import { FakeEl } from "@tests/helpers/fake-obsidian-dom";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { onLongPress } from "@/ui/common/long-press";

const onControl = { closest: () => ({}) };

describe("onLongPress", () => {
	let el: FakeEl;
	let handler: Mock<(event: MouseEvent) => void>;
	let clicked: Mock<() => void>;
	let contextMenu: Mock<() => void>;

	const touch = (type: string, extra: Record<string, unknown> = {}) =>
		el.fire(type, { pointerType: "touch", clientX: 0, clientY: 0, ...extra });
	const hold = () => {
		touch("pointerdown");
		vi.advanceTimersByTime(500);
	};
	const tap = () => {
		touch("pointerdown");
		touch("pointerup");
		el.fire("click");
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
		el = Object.assign(new FakeEl("div"), { isConnected: true });
		handler = vi.fn<(event: MouseEvent) => void>();
		clicked = vi.fn();
		contextMenu = vi.fn();
		onLongPress(el as unknown as HTMLElement, handler);
		el.addEventListener("click", clicked);
		el.addEventListener("contextmenu", contextMenu);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("fires once a touch is held", () => {
		touch("pointerdown");
		vi.advanceTimersByTime(499);
		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("swallows the click that ends the hold, once", () => {
		hold();
		touch("pointerup");
		expect(el.fire("click").defaultPrevented).toBe(true);
		expect(clicked).not.toHaveBeenCalled();
		el.fire("click");
		expect(clicked).toHaveBeenCalledOnce();
	});

	it("lets a tap through", () => {
		tap();
		expect(clicked).toHaveBeenCalledOnce();
		expect(handler).not.toHaveBeenCalled();
	});

	it("leaves a mouse press to the context menu", () => {
		el.fire("pointerdown", { pointerType: "mouse" });
		vi.advanceTimersByTime(1000);
		expect(handler).not.toHaveBeenCalled();
	});

	it("reads a slide as a scroll", () => {
		touch("pointerdown");
		touch("pointermove", { clientY: 11 });
		vi.advanceTimersByTime(1000);
		expect(handler).not.toHaveBeenCalled();
	});

	it("tolerates finger jitter below the slop", () => {
		touch("pointerdown");
		touch("pointermove", { clientX: 4, clientY: 4 });
		vi.advanceTimersByTime(500);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("is cancelled by lifting early", () => {
		touch("pointerdown");
		vi.advanceTimersByTime(200);
		touch("pointerup");
		vi.advanceTimersByTime(1000);
		expect(handler).not.toHaveBeenCalled();
	});

	it("does nothing for a row re-rendered away during the hold", () => {
		touch("pointerdown");
		el.isConnected = false;
		vi.advanceTimersByTime(500);
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not let a hold that never got its click swallow the next tap", () => {
		hold();
		touch("pointercancel");
		tap();
		expect(clicked).toHaveBeenCalledOnce();
	});

	it("does not let a hold that ended on a lifted finger swallow the next tap", () => {
		hold();
		touch("pointerup");
		tap();
		expect(clicked).toHaveBeenCalledOnce();
	});

	it("ignores a press that starts on a control inside the row", () => {
		touch("pointerdown", { target: onControl });
		vi.advanceTimersByTime(1000);
		touch("pointerup");
		el.fire("click");
		expect(handler).not.toHaveBeenCalled();
		expect(clicked).toHaveBeenCalledOnce();
	});

	it("opens one menu when Android sends contextmenu before the timer", () => {
		touch("pointerdown");
		vi.advanceTimersByTime(300);
		const event = el.fire("contextmenu", { pointerType: "touch" });
		vi.advanceTimersByTime(1000);
		expect(handler).toHaveBeenCalledOnce();
		expect(event.defaultPrevented).toBe(true);
		expect(contextMenu).not.toHaveBeenCalled();
	});

	it("opens one menu when Android sends contextmenu after the timer", () => {
		hold();
		el.fire("contextmenu", { pointerType: "touch" });
		expect(handler).toHaveBeenCalledOnce();
		expect(contextMenu).not.toHaveBeenCalled();
	});

	it("leaves a mouse right click to the row's own contextmenu handler", () => {
		el.fire("pointerdown", { pointerType: "mouse" });
		el.fire("contextmenu", { pointerType: "mouse" });
		expect(handler).not.toHaveBeenCalled();
		expect(contextMenu).toHaveBeenCalledOnce();
	});

	it("leaves a keyboard contextmenu alone after an earlier hold", () => {
		hold();
		touch("pointerup");
		el.fire("contextmenu");
		expect(contextMenu).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledOnce();
	});

	it("leaves the contextmenu of a press on a control to its handler", () => {
		touch("pointerdown", { target: onControl });
		el.fire("contextmenu", { pointerType: "touch" });
		expect(contextMenu).toHaveBeenCalledOnce();
		expect(handler).not.toHaveBeenCalled();
	});
});
