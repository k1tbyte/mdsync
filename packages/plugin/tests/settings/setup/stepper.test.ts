// @vitest-environment jsdom

import { installElementMethods } from "@tests/settings/setup/element-methods";
import { describe, expect, it } from "vitest";

import {
	createStepper,
	EStepState,
	stepStates,
} from "@/settings/setup/stepper";

installElementMethods();

const STEPS = ["storage", "passphrase", "relay", "ready"] as const;
const { Done, Current, Skipped, Ahead } = EStepState;

describe("stepStates", () => {
	it("marks the first step current and the rest ahead", () => {
		expect(stepStates(STEPS, "storage", () => false)).toEqual([
			Current,
			Ahead,
			Ahead,
			Ahead,
		]);
	});

	it("marks finished steps before the current one done", () => {
		expect(stepStates(STEPS, "relay", () => true)).toEqual([
			Done,
			Done,
			Current,
			Ahead,
		]);
	});

	it("marks a passed step that is not finished as skipped", () => {
		expect(stepStates(STEPS, "ready", (step) => step !== "relay")).toEqual([
			Done,
			Done,
			Skipped,
			Current,
		]);
	});

	it("does not mark a step ahead done, even when its work is already there", () => {
		expect(stepStates(STEPS, "storage", () => true)).toEqual([
			Current,
			Ahead,
			Ahead,
			Ahead,
		]);
	});

	it("puts every step ahead when the current one is not on the path", () => {
		expect(stepStates(STEPS, "start" as never, () => true)).toEqual([
			Ahead,
			Ahead,
			Ahead,
			Ahead,
		]);
	});
});

describe("createStepper", () => {
	it("names the list and speaks each step's state", () => {
		const parent = document.createElement("div");
		const stepper = createStepper(parent);
		stepper.update(
			[Done, Current, Ahead].map((state, at) => ({
				id: String(at),
				label: `Step ${at}`,
				icon: "dot",
				state,
			})),
		);
		const list = parent.querySelector("ol");
		expect(list?.getAttribute("aria-label")).toBe("Setup steps");
		const [done, current, ahead] = Array.from(list?.children ?? []);
		expect(done?.getAttribute("aria-label")).toBe("Step 0, done");
		expect(current?.getAttribute("aria-current")).toBe("step");
		expect(current?.hasAttribute("aria-label")).toBe(false);
		expect(ahead?.getAttribute("aria-label")).toBe("Step 2, upcoming");
	});
});
