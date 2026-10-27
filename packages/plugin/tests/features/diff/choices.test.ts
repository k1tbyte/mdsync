import { describe, expect, it } from "vitest";
import { EChoiceKind, HunkChoices } from "@/features/diff/choices";

describe("HunkChoices", () => {
	it("toggles a segment on, replaces its kind, and off again", () => {
		const choices = new HunkChoices();
		const ref = { hunk: 2, segment: 1 };
		choices.toggle(ref, EChoiceKind.Push);
		expect(choices.kindOf(ref)).toBe(EChoiceKind.Push);
		expect(choices.size).toBe(1);

		choices.toggle(ref, EChoiceKind.Revert);
		expect(choices.kindOf(ref)).toBe(EChoiceKind.Revert);
		expect(choices.size).toBe(1);

		choices.toggle(ref, EChoiceKind.Revert);
		expect(choices.kindOf(ref)).toBeUndefined();
		expect(choices.size).toBe(0);
	});

	it("splits choices into one selection per kind", () => {
		const choices = new HunkChoices();
		choices.toggle({ hunk: 0, segment: 0 }, EChoiceKind.Push);
		choices.toggle({ hunk: 0, segment: 1 }, EChoiceKind.Revert);
		choices.toggle({ hunk: 3, segment: 0 }, EChoiceKind.Push);

		const push = choices.selection(EChoiceKind.Push);
		expect([...(push.get(0) ?? [])]).toEqual([0]);
		expect([...(push.get(3) ?? [])]).toEqual([0]);
		const revert = choices.selection(EChoiceKind.Revert);
		expect([...(revert.get(0) ?? [])]).toEqual([1]);
		expect(revert.has(3)).toBe(false);
		expect(choices.selection(EChoiceKind.Pull).size).toBe(0);
		expect(choices.count(EChoiceKind.Push)).toBe(2);
		expect(choices.count(EChoiceKind.Revert)).toBe(1);
		expect(choices.count(EChoiceKind.Pull)).toBe(0);
	});

	it("clear forgets everything", () => {
		const choices = new HunkChoices();
		choices.toggle({ hunk: 1, segment: 0 }, EChoiceKind.Pull);
		choices.clear();
		expect(choices.size).toBe(0);
		expect(choices.selection(EChoiceKind.Pull).size).toBe(0);
	});
});
