import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import type { CompareResult } from "@/features/sync/engine";
import type { LiveNotes } from "@/features/sync/live-notes";
import { pushPathsOp } from "@/features/sync/operations/push";
import { batchAcceptRemoteOp } from "@/features/sync/operations/resolve";
import { revertPathsOp } from "@/features/sync/operations/revert";

useEncryptionKey();

const MARK = { doc: "doc", gen: 0, seq: 4 };

/** Closed rooms, or a room holding every note. */
function liveNotes(held = false): { live: LiveNotes; wrote: () => void } {
	const wrote = vi.fn(async () => undefined);
	const live = {
		absorb: async () => (held ? "later" : "cold"),
		mark: async () => null,
		holds: () => held,
		wrote,
	} as unknown as LiveNotes;
	return { live, wrote };
}

/** `a` published "shared", then edited it to `local`. */
async function edited(local: string): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	a.adapter.putText("note.md", "shared\n");
	await pushPathsOp(a.deps(), await a.compare(), ["note.md"], a.context());
	a.adapter.putText("note.md", local);
	return [a, b];
}

/** `a` edited the note while `b` published "remote" over it. */
async function conflicted(): Promise<TestSession> {
	const [a, b] = await edited("local\n");
	b.adapter.putText("note.md", "shared\n");
	await b.adoptRemote();
	b.adapter.putText("note.md", "remote\n");
	await pushPathsOp(b.deps(), await b.compare(), ["note.md"], b.context());
	return a;
}

function marked(result: CompareResult): CompareResult {
	const remote = result.remote?.files["note.md"];
	if (!result.remote || !remote) throw new Error("expected the remote note");
	result.remote.files["note.md"] = { ...remote, live: MARK };
	return result;
}

describe("accepting the remote side of a live note", () => {
	it("makes the room snapshot its merge base", async () => {
		const a = await conflicted();
		const { live, wrote } = liveNotes();
		const result = marked(await a.compare());
		await batchAcceptRemoteOp(
			{ ...a.deps(), live },
			result,
			new Set(["note.md"]),
			a.context(),
		);
		expect(a.text("note.md")).toBe("remote\n");
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, "remote\n");
	});

	it("leaves a note whose room is not ready to take it in", async () => {
		const a = await conflicted();
		const { live } = liveNotes(true);
		const accepting = batchAcceptRemoteOp(
			{ ...a.deps(), live },
			await a.compare(),
			new Set(["note.md"]),
			a.context(),
		);
		await expect(accepting).rejects.toThrow("live editing");
		expect(a.text("note.md")).toBe("local\n");
	});
});

describe("reverting a live note", () => {
	it("makes the restored room snapshot its merge base", async () => {
		const [a] = await edited("scribbled\n");
		const { baseline } = a.state;
		const entry = baseline?.files["note.md"];
		if (!baseline || !entry) throw new Error("expected a baseline");
		const files = { ...baseline.files, "note.md": { ...entry, live: MARK } };
		a.state = { ...a.state, baseline: { ...baseline, files } };
		const { live, wrote } = liveNotes();
		await revertPathsOp(
			{ ...a.deps(), live },
			await a.compare(),
			["note.md"],
			a.context(),
		);
		expect(a.text("note.md")).toBe("shared\n");
		expect(wrote).toHaveBeenCalledWith("note.md", MARK, "shared\n");
	});

	it("leaves a note an open room holds", async () => {
		const [a] = await edited("scribbled\n");
		const { live } = liveNotes(true);
		const reverting = revertPathsOp(
			{ ...a.deps(), live },
			await a.compare(),
			["note.md"],
			a.context(),
		);
		await expect(reverting).rejects.toThrow("live editing");
		expect(a.text("note.md")).toBe("scribbled\n");
	});
});
