import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameTask } from "@/core/ui/frame-task";

describe("frameTask", () => {
	const win = window as unknown as {
		requestAnimationFrame: unknown;
		cancelAnimationFrame: unknown;
	};
	const original = {
		request: win.requestAnimationFrame,
		cancel: win.cancelAnimationFrame,
	};
	let queue: Map<number, () => void>;
	let request: ReturnType<typeof vi.fn>;
	let cancel: ReturnType<typeof vi.fn>;

	const flush = (): void => {
		const due = [...queue.values()];
		queue.clear();
		for (const callback of due) callback();
	};

	beforeEach(() => {
		queue = new Map();
		let next = 0;
		request = vi.fn((callback: () => void) => {
			queue.set(++next, callback);
			return next;
		});
		cancel = vi.fn((id: number) => queue.delete(id));
		win.requestAnimationFrame = request;
		win.cancelAnimationFrame = cancel;
	});

	afterEach(() => {
		win.requestAnimationFrame = original.request;
		win.cancelAnimationFrame = original.cancel;
	});

	it("runs once on the next frame however often it is scheduled", () => {
		const task = vi.fn();
		const frame = frameTask(task);
		frame.schedule();
		frame.schedule();
		expect(request).toHaveBeenCalledTimes(1);
		expect(task).not.toHaveBeenCalled();
		flush();
		expect(task).toHaveBeenCalledTimes(1);
	});

	it("does not run once cancelled", () => {
		const task = vi.fn();
		const frame = frameTask(task);
		frame.schedule();
		frame.cancel();
		expect(cancel).toHaveBeenCalledTimes(1);
		flush();
		expect(task).not.toHaveBeenCalled();
	});

	it("cancels nothing when no frame is pending", () => {
		const frame = frameTask(vi.fn());
		frame.cancel();
		frame.schedule();
		flush();
		frame.cancel();
		expect(cancel).not.toHaveBeenCalled();
	});

	it("schedules again after a run or a cancel", () => {
		const task = vi.fn();
		const frame = frameTask(task);
		frame.schedule();
		flush();
		frame.schedule();
		expect(request).toHaveBeenCalledTimes(2);
		flush();
		expect(task).toHaveBeenCalledTimes(2);
		frame.schedule();
		frame.cancel();
		frame.schedule();
		flush();
		expect(request).toHaveBeenCalledTimes(4);
		expect(task).toHaveBeenCalledTimes(3);
	});

	it("lets the task schedule the next frame", () => {
		const frame = frameTask(() => {
			if (request.mock.calls.length < 2) frame.schedule();
		});
		frame.schedule();
		flush();
		expect(request).toHaveBeenCalledTimes(2);
	});
});
