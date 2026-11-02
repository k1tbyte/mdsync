import { describe, expect, it, vi } from "vitest";
import { observeResize } from "@/core/ui/observe-resize";

/** A window whose observers record what they watch. */
function fakeWindow() {
	const watched: object[] = [];
	const stopped: object[] = [];
	class ResizeObserver {
		observe(target: object): void {
			watched.push(target);
		}
		disconnect(): void {
			stopped.push(this);
		}
	}
	return { win: { ResizeObserver }, watched, stopped };
}

function element(win: object) {
	let migrated: ((win: Window) => void) | null = null;
	const unmigrated = vi.fn();
	const el = {
		win,
		onWindowMigrated(listener: (win: Window) => void) {
			migrated = listener;
			return unmigrated;
		},
	};
	const moveTo = (next: object) => {
		el.win = next;
		migrated?.(next as Window);
	};
	return { el: el as unknown as HTMLElement, moveTo, unmigrated };
}

describe("observeResize", () => {
	it("observes with the element's window, again with the next one after a move", () => {
		const main = fakeWindow();
		const popout = fakeWindow();
		const { el, moveTo } = element(main.win);
		observeResize(el, () => {});
		expect(main.watched).toEqual([el]);
		moveTo(popout.win);
		expect(main.stopped).toHaveLength(1);
		expect(popout.watched).toEqual([el]);
	});

	it("stops the observer and the move listener", () => {
		const main = fakeWindow();
		const { el, unmigrated } = element(main.win);
		observeResize(el, () => {})();
		expect(main.stopped).toHaveLength(1);
		expect(unmigrated).toHaveBeenCalledOnce();
	});
});
