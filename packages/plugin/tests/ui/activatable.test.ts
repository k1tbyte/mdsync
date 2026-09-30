import { FakeEl } from "@tests/helpers/fake-dom";
import { describe, expect, it, vi } from "vitest";

import { makeActivatable } from "@/ui/common/activatable";

function setup(label: string | null = "Open it") {
	const el = new FakeEl("span");
	const activate = vi.fn();
	makeActivatable(el as unknown as HTMLElement, label, activate);
	return { el, activate };
}

describe("an activatable element", () => {
	it("is a named button with a tab stop", () => {
		const { el } = setup("Open it");

		expect(el.attrs.get("role")).toBe("button");
		expect(el.attrs.get("tabindex")).toBe("0");
		expect(el.attrs.get("aria-label")).toBe("Open it");
	});

	it("keeps the caller's own name when given none", () => {
		const el = new FakeEl("span");
		el.setAttr("aria-label", "Live now");

		makeActivatable(el as unknown as HTMLElement, null, () => {});

		expect(el.attrs.get("aria-label")).toBe("Live now");
	});

	it("activates on click", () => {
		const { el, activate } = setup();

		el.fire("click");

		expect(activate).toHaveBeenCalledTimes(1);
	});

	it.each(["Enter", " "])(
		"activates on %j, without the page scrolling",
		(key) => {
			const { el, activate } = setup();

			const event = el.fire("keydown", { key, target: el });

			expect(activate).toHaveBeenCalledTimes(1);
			expect(event.defaultPrevented).toBe(true);
		},
	);

	it("ignores other keys", () => {
		const { el, activate } = setup();

		const event = el.fire("keydown", { key: "a", target: el });

		expect(activate).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves a key pressed on a control inside it to that control", () => {
		const { el, activate } = setup();

		const event = el.fire("keydown", {
			key: "Enter",
			target: new FakeEl("button"),
		});

		expect(activate).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});
});
