import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "@/crypto";
import { autoMergeOp } from "@/sync/auto-merge";
import { textToBytes } from "@/sync/content";
import type { IncomingText, LiveNotes, LiveTake } from "@/sync/live-notes";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";
import type { LiveMark } from "@/sync/types";

useEncryptionKey();

const NOTE = "note.md";

/** A snapshot of the note's room at `seq`, `gen` rotations in. */
function snap(seq: number, gen = 0): LiveMark {
	return { doc: "d", gen, seq };
}

/** Live editing as the cold sync sees it: which texts are room snapshots, which rooms are open. */
class FakeLive implements LiveNotes {
	private readonly snapshots = new Map<string, LiveMark>();
	/** Path -> the doc of its open, synced room. */
	readonly rooms = new Map<string, string>();
	readonly absorbed: Array<IncomingText | null> = [];
	readonly written: Array<{ path: string; mark: LiveMark; text: string }> = [];

	async snapshot(text: string, mark: LiveMark): Promise<void> {
		this.snapshots.set(await sha256Hex(textToBytes(text)), mark);
	}

	async mark(path: string, hash: string): Promise<LiveMark | "later" | null> {
		return this.snapshots.get(hash) ?? (this.rooms.has(path) ? "later" : null);
	}

	async absorb(
		path: string,
		mark: LiveMark | undefined,
		texts: () => Promise<IncomingText | null>,
	): Promise<LiveTake> {
		const doc = this.rooms.get(path);
		if (doc === undefined) return "cold";
		if (mark?.doc !== doc) this.absorbed.push(await texts());
		return "taken";
	}

	async wrote(path: string, mark: LiveMark, text: string): Promise<void> {
		this.written.push({ path, mark, text });
	}
}

async function push(
	device: TestSession,
	live: LiveNotes = new FakeLive(),
	paths = [NOTE],
) {
	const result = await device.compare();
	return pushPathsOp(
		{ ...device.deps(), live },
		result,
		paths,
		device.context(),
	);
}

/** Both devices hold `text` as their synced baseline. */
async function shared(text: string): Promise<[TestSession, TestSession]> {
	const [a, b] = pairedSessions();
	a.adapter.putText(NOTE, text);
	await push(a);
	b.adapter.putText(NOTE, text);
	await b.adoptRemote();
	return [a, b];
}

async function markedPush(device: TestSession, text: string, mark: LiveMark) {
	const live = new FakeLive();
	await live.snapshot(text, mark);
	device.adapter.putText(NOTE, text);
	return push(device, live);
}

describe("pushing a live note", () => {
	it("marks a version that is its room's agreed text", async () => {
		const [a] = pairedSessions();

		const outcome = await markedPush(a, "hello\n", snap(4));

		expect(outcome.newRemote?.files[NOTE]?.live).toEqual(snap(4));
	});

	it("holds back a note its open room has not settled on", async () => {
		const [a] = pairedSessions();
		const live = new FakeLive();
		live.rooms.set(NOTE, "d");
		a.adapter.putText(NOTE, "typing\n");
		a.adapter.putText("plain.md", "plain\n");

		const outcome = await push(a, live, [NOTE, "plain.md"]);

		expect(Object.keys(outcome.newRemote?.files ?? {})).toEqual(["plain.md"]);
		expect([...outcome.touchedPaths]).toEqual(["plain.md"]);
	});

	it("never publishes a snapshot older than the remote one", async () => {
		const [a, b] = await shared("one\n");
		await markedPush(b, "one\ntwo\nthree\n", snap(9));
		await a.adoptRemote();

		const outcome = await markedPush(a, "one\ntwo\n", snap(5));

		expect(outcome.touchedPaths.size).toBe(0);
		expect((await a.compare()).remote?.files[NOTE]?.live?.seq).toBe(9);
	});
});

describe("an incoming version of a live note", () => {
	it("goes into the open room, never over the file", async () => {
		const [a, b] = await shared("one\n");
		b.adapter.putText(NOTE, "one\ntwo\n");
		await push(b);
		const live = new FakeLive();
		live.rooms.set(NOTE, "d");
		const result = await a.compare();

		await pullPathsOp({ ...a.deps(), live }, result, [NOTE], a.context());

		expect(a.text(NOTE)).toBe("one\n");
		expect(live.absorbed).toEqual([{ base: "one\n", incoming: "one\ntwo\n" }]);
		const after = await a.compare();
		expect(after.diff.remoteChanges).toEqual([]);
		expect(after.diff.localChanges.map((c) => c.path)).toEqual([NOTE]);
	});

	it("is not merged again when the open room is where it came from", async () => {
		const [a, b] = await shared("one\n");
		await markedPush(b, "one\ntwo\n", snap(2));
		const live = new FakeLive();
		live.rooms.set(NOTE, "d");
		a.adapter.putText(NOTE, "one\ntwo\nthree\n");
		const result = await a.compare();
		expect(result.diff.conflicts.map((c) => c.path)).toEqual([NOTE]);

		const outcome = await autoMergeOp(
			{ ...a.deps(), live },
			result,
			a.context(),
		);

		expect(live.absorbed).toEqual([]);
		expect(a.text(NOTE)).toBe("one\ntwo\nthree\n");
		expect(outcome.touchedPaths).toEqual(new Set([NOTE]));
		expect((await a.compare()).diff.conflicts).toEqual([]);
	});

	it("keeps an open note another device deleted", async () => {
		const [a, b] = await shared("one\n");
		await b.adapter.remove(NOTE);
		await push(b);
		const live = new FakeLive();
		live.rooms.set(NOTE, "d");
		const result = await a.compare();

		await pullPathsOp({ ...a.deps(), live }, result, [NOTE], a.context());

		expect(a.text(NOTE)).toBe("one\n");
		const after = await a.compare();
		expect(after.diff.localChanges.map((c) => [c.path, c.type])).toEqual([
			[NOTE, "local-add"],
		]);
	});

	it("records a room snapshot written to a closed note as its merge base", async () => {
		const [a, b] = await shared("one\n");
		await markedPush(b, "one\ntwo\n", snap(2));
		const live = new FakeLive();
		const result = await a.compare();

		await pullPathsOp({ ...a.deps(), live }, result, [NOTE], a.context());

		expect(a.text(NOTE)).toBe("one\ntwo\n");
		expect(live.written).toEqual([
			{ path: NOTE, mark: snap(2), text: "one\ntwo\n" },
		]);
	});
});

describe("settling live conflicts", () => {
	it("keeps them settled on a device that never synced", async () => {
		const [a, b] = pairedSessions();
		await markedPush(b, "from the room\n", snap(3));
		a.adapter.putText(NOTE, "from the room\nand more\n");
		const live = new FakeLive();
		live.rooms.set(NOTE, "d");
		const result = await a.compare();

		await autoMergeOp({ ...a.deps(), live }, result, a.context());

		const after = await a.compare();
		expect(after.diff.conflicts).toEqual([]);
		expect(after.diff.localChanges.map((c) => c.path)).toEqual([NOTE]);
	});

	it("records the room snapshot a merged closed note grew from", async () => {
		const [a, b] = await shared("one\ntwo\nthree\n");
		await markedPush(b, "one\ntwo\nthree\nfour\n", snap(6));
		a.adapter.putText(NOTE, "zero\none\ntwo\nthree\n");
		const live = new FakeLive();
		const result = await a.compare();

		await autoMergeOp({ ...a.deps(), live }, result, a.context());

		expect(a.text(NOTE)).toBe("zero\none\ntwo\nthree\nfour\n");
		expect(live.written).toEqual([
			{
				path: NOTE,
				mark: snap(6),
				text: "one\ntwo\nthree\nfour\n",
			},
		]);
	});
});

describe("two snapshots of one room on a closed note", () => {
	async function conflict(local: LiveMark, remote: LiveMark) {
		const [a, b] = await shared("one\n");
		await markedPush(b, "one\nremote\n", remote);
		const live = new FakeLive();
		a.adapter.putText(NOTE, "one\nlocal\n");
		await live.snapshot("one\nlocal\n", local);
		const result = await a.compare();
		const outcome = await autoMergeOp(
			{ ...a.deps(), live },
			result,
			a.context(),
		);
		return { a, live, outcome };
	}

	it("keeps the local one when it is later", async () => {
		const { a, outcome } = await conflict(snap(7), snap(5));

		expect(a.text(NOTE)).toBe("one\nlocal\n");
		expect(outcome.touchedPaths).toEqual(new Set([NOTE]));
		const after = await a.compare();
		expect(after.diff.conflicts).toEqual([]);
		expect(after.diff.localChanges.map((c) => c.path)).toEqual([NOTE]);
	});

	it("takes the remote one when it is later, without a merge", async () => {
		const { a, live } = await conflict(snap(5), snap(7));

		expect(a.text(NOTE)).toBe("one\nremote\n");
		expect(live.written.map((w) => w.mark)).toEqual([snap(7)]);
		const after = await a.compare();
		expect(after.diff.conflicts).toEqual([]);
		expect(after.diff.localChanges).toEqual([]);
	});

	it("orders a rebuilt room after every snapshot of the one before", async () => {
		const later = await conflict(snap(2, 1), snap(90));
		const earlier = await conflict(snap(90), snap(2, 1));

		expect(later.a.text(NOTE)).toBe("one\nlocal\n");
		expect(earlier.a.text(NOTE)).toBe("one\nremote\n");
	});
});
