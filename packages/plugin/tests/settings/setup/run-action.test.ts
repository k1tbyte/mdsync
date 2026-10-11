import { describe, expect, it, vi } from "vitest";
import { runAction } from "@/settings/setup/run-action";

function setup() {
	const wizard = { redraw: vi.fn() };
	const state = { busy: false, error: "stale" };
	return { wizard, state };
}

describe("runAction", () => {
	it("is busy while the task runs and idle with a clean error after it succeeds", async () => {
		const { wizard, state } = setup();
		let busyDuring = false;

		const done = await runAction(wizard, state, async () => {
			busyDuring = state.busy;
		});

		expect(done).toBe(true);
		expect(busyDuring).toBe(true);
		expect(state).toEqual({ busy: false, error: "" });
		expect(wizard.redraw).toHaveBeenCalledTimes(2);
	});

	it("keeps the failure in state and redraws", async () => {
		const { wizard, state } = setup();

		const done = await runAction(wizard, state, async () => {
			throw new Error("nope");
		});

		expect(done).toBe(false);
		expect(state).toEqual({ busy: false, error: "nope" });
		expect(wizard.redraw).toHaveBeenCalledTimes(2);
	});

	it("words a failure through describe", async () => {
		const { wizard, state } = setup();

		await runAction(
			wizard,
			state,
			async () => {
				throw new Error("raw");
			},
			(err) => `wrapped ${(err as Error).message}`,
		);

		expect(state.error).toBe("wrapped raw");
	});

	it("ignores a second call while one runs", async () => {
		const { wizard, state } = setup();
		let release = () => {};
		const task = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);

		const first = runAction(wizard, state, task);
		expect(await runAction(wizard, state, task)).toBe(false);
		release();
		await first;

		expect(task).toHaveBeenCalledTimes(1);
	});
});
