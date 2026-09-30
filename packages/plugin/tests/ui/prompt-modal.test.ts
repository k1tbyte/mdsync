import type { FakeEl } from "@tests/helpers/fake-dom";
import { FakeModal } from "@tests/helpers/fake-obsidian-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPromptModal } from "@/ui/modals/prompt-modal";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function ask(initialValue = "", allowEmpty = false) {
	const open = vi.spyOn(FakeModal.prototype, "open");
	const answer = openPromptModal({
		app: {} as never,
		title: "Name the snapshot",
		initialValue,
		confirmLabel: "Save",
		label: "Snapshot name",
		allowEmpty,
	});
	const modal = open.mock.contexts.at(-1) as FakeModal;
	const field = modal.contentEl.find((el) => el.tag === "input")[0] as FakeEl;
	return { answer, modal, field };
}

const enter = (field: FakeEl, init: Record<string, unknown> = {}) =>
	field.fire("keydown", {
		key: "Enter",
		isComposing: false,
		keyCode: 13,
		preventDefault: () => {},
		...init,
	});

beforeEach(() => {
	vi.stubGlobal("window", { ...globalThis, setTimeout: () => 0 });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("openPromptModal", () => {
	it("labels the field for a screen reader", () => {
		const { field } = ask();

		expect(field.attrs.get("aria-label")).toBe("Snapshot name");
	});

	it("answers with the trimmed text on Enter", async () => {
		const { answer, field } = ask();
		field.value = "  release  ";

		enter(field);

		expect(await answer).toBe("release");
	});

	it("does not answer on the Enter that confirms an IME composition", async () => {
		const { answer, modal, field } = ask();
		field.value = "リリース";

		enter(field, { isComposing: true });
		await settle();
		modal.close();

		expect(await answer).toBeNull();
	});

	it("answers with nothing when left empty, unless empty is the point", async () => {
		const empty = ask();
		enter(empty.field);
		const allowed = ask("x", true);
		allowed.field.value = "  ";
		enter(allowed.field);

		expect(await empty.answer).toBeNull();
		expect(await allowed.answer).toBe("");
	});
});
