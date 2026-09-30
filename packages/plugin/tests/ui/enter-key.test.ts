import { FakeEl } from "@tests/helpers/fake-dom";
import { describe, expect, it, vi } from "vitest";
import { onEnter, serial } from "@/ui/common/enter-key";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
	let finish: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		finish = resolve;
	});
	return { promise, finish };
}

function key(input: FakeEl, init: Record<string, unknown> = {}) {
	const preventDefault = vi.fn();
	input.fire("keydown", {
		key: "Enter",
		isComposing: false,
		keyCode: 13,
		preventDefault,
		...init,
	});
	return preventDefault;
}

describe("serial", () => {
	it("runs the action with its arguments", async () => {
		const action = vi.fn(async (_a: number, _b: string) => {});

		await serial(action)(1, "x");

		expect(action).toHaveBeenCalledWith(1, "x");
	});

	it("drops a call made while the last one is still pending", async () => {
		const gate = deferred();
		const action = vi.fn(() => gate.promise);
		const run = serial(action);

		const first = run();
		await run();
		gate.finish();
		await first;

		expect(action).toHaveBeenCalledTimes(1);
	});

	it("takes the next call once the last one settled", async () => {
		const action = vi.fn(async () => {});
		const run = serial(action);

		await run();
		await run();

		expect(action).toHaveBeenCalledTimes(2);
	});

	it("takes the next call after one that failed", async () => {
		const action = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("no"))
			.mockResolvedValueOnce(undefined);
		const run = serial(action);

		await expect(run()).rejects.toThrow("no");
		await run();

		expect(action).toHaveBeenCalledTimes(2);
	});
});

describe("onEnter", () => {
	it("runs the action on Enter and keeps the key from doing anything else", async () => {
		const input = new FakeEl("input");
		const action = vi.fn();
		onEnter(input as unknown as HTMLElement, action);

		const preventDefault = key(input);
		await settle();

		expect(action).toHaveBeenCalledTimes(1);
		expect(preventDefault).toHaveBeenCalled();
	});

	it("ignores every other key", async () => {
		const input = new FakeEl("input");
		const action = vi.fn();
		onEnter(input as unknown as HTMLElement, action);

		key(input, { key: "a", keyCode: 65 });
		key(input, { key: "Escape", keyCode: 27 });
		await settle();

		expect(action).not.toHaveBeenCalled();
	});

	it("ignores the Enter that confirms an IME composition", async () => {
		const input = new FakeEl("input");
		const action = vi.fn();
		onEnter(input as unknown as HTMLElement, action);

		const composing = key(input, { isComposing: true });
		key(input, { keyCode: 229 });
		await settle();

		expect(action).not.toHaveBeenCalled();
		expect(composing).not.toHaveBeenCalled();
	});

	it("ignores an Enter while the action of the last one is still pending", async () => {
		const gate = deferred();
		const input = new FakeEl("input");
		const action = vi.fn(() => gate.promise);
		onEnter(input as unknown as HTMLElement, action);

		key(input);
		key(input);
		gate.finish();
		await settle();
		key(input);
		await settle();

		expect(action).toHaveBeenCalledTimes(2);
	});

	it("treats Enter with a modifier as Enter: these inputs are single-line", async () => {
		const input = new FakeEl("input");
		const action = vi.fn();
		onEnter(input as unknown as HTMLElement, action);

		key(input, { shiftKey: true });
		await settle();

		expect(action).toHaveBeenCalledTimes(1);
	});

	it("shares a guard with a click when both run the same serial action", async () => {
		const gate = deferred();
		const input = new FakeEl("input");
		const action = vi.fn(() => gate.promise);
		const submit = serial(action);
		onEnter(input as unknown as HTMLElement, submit);

		void submit();
		key(input);
		gate.finish();
		await settle();

		expect(action).toHaveBeenCalledTimes(1);
	});
});
