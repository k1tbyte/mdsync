import { describe, expect, it } from "vitest";

import { Unseen } from "@/presence/unseen";

function unseen(saved: unknown = []) {
	const store = {
		saved,
		load: () => saved,
		save(paths: string[]) {
			store.saved = paths;
		},
	};
	return { model: new Unseen(store), store };
}

describe("unseen files", () => {
	it("keeps what others changed until it is opened", () => {
		const { model, store } = unseen();
		model.add(["a.md", "b.md"]);
		model.drop("a.md");

		expect([...model.all()]).toEqual(["b.md"]);
		expect(store.saved).toEqual(["b.md"]);
	});

	it("follows a renamed folder and forgets a deleted one", () => {
		const { model } = unseen(["Team/a.md", "Team/x/b.md", "Other.md"]);
		model.move("Team", "Club");

		expect([...model.all()].sort()).toEqual([
			"Club/a.md",
			"Club/x/b.md",
			"Other.md",
		]);
		model.drop("Club/x");
		expect([...model.all()].sort()).toEqual(["Club/a.md", "Other.md"]);
	});

	it("tells listeners only about real changes and ignores junk saved", () => {
		const { model } = unseen(["a.md", 3, null]);
		let calls = 0;
		model.subscribe(() => calls++);
		model.add(["a.md"]);
		model.drop("missing.md");
		model.add(["b.md"]);

		expect(calls).toBe(1);
		expect([...model.all()]).toEqual(["a.md", "b.md"]);
	});
});
