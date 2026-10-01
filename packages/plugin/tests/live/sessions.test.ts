import { EFrame, MAX_DOC_SUBS } from "@obsync/protocol";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { LiveHub, type TestConnection } from "@tests/helpers/live-hub";
import { type App, type DataAdapter, MarkdownView, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@/crypto";
import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { seal } from "@/crypto/seal";
import { AgreedTexts } from "@/live/cold/agreed-texts";
import { LiveColdSync } from "@/live/cold/cold-sync";
import { docIdFor } from "@/live/doc-id";
import { FollowerSession } from "@/live/session/follower-session";
import type { LiveSession } from "@/live/session/session";
import { bindEditor } from "@/live/text/binding";
import type { TextModel } from "@/live/text/model";
import { LiveSessions } from "@/live/workspace/sessions";
import type { LiveSpace } from "@/live/workspace/space";

vi.mock("@/live/text/binding", () => ({
	bindEditor: vi.fn(() => ({ detach: vi.fn(), showAuthors: vi.fn() })),
}));

const USER = { key: "d1", name: "laptop", color: "red", device: null };

function editorOf(file: TFile, mode = "source"): MarkdownView {
	return Object.assign(Object.create(MarkdownView.prototype), {
		file,
		getMode: () => mode,
		editor: { getValue: () => "text" },
		save: vi.fn(async () => undefined),
	});
}

let hub: LiveHub;
let connection: TestConnection;
let keys: LiveKeys | null;
/** Where a path goes live; by default the vault, and nothing under Shared/. */
let spaceOf: (path: string) => LiveSpace | null;
let leaves: { view: MarkdownView }[];
let agreed: AgreedTexts;
let sessions: LiveSessions;
let authorsShown: boolean;

beforeEach(async () => {
	vi.mocked(bindEditor).mockClear();
	hub = new LiveHub();
	connection = hub.connection();
	connection.connect();
	keys = await freshKeys();
	spaceOf = (path) => (path.startsWith("Shared/") ? null : vault());
	leaves = [];
	authorsShown = false;
	agreed = new AgreedTexts(
		new InMemoryAdapter() as unknown as DataAdapter,
		".obsidian",
	);
	sessions = new LiveSessions({
		app: fakeApp(),
		hub: connection,
		liveSpace: async (path) => spaceOf(path),
		agreed,
		baseText: async () => null,
		moveFile: async () => false,
		authorsShown: () => authorsShown,
		nameOf: () => null,
	});
});

afterEach(() => sessions.dispose());

function fakeApp(): App {
	return {
		workspace: {
			getLeavesOfType: (type: string) => (type === "markdown" ? leaves : []),
		},
		vault: { getFileByPath: () => null, read: async () => "" },
		metadataCache: { getFileCache: () => ({}) },
	} as unknown as App;
}

function note(path: string, size = 10): TFile {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		stat: { size },
	});
}

function vault(): LiveSpace | null {
	return keys && { id: "vault", root: "", keys, person: "owner", user: USER };
}

function freshKeys(): Promise<LiveKeys> {
	return deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
}

/** The rooms this device follows on the hub. */
function followed(): string[] {
	return [...hub.peers].flatMap((peer) => peer.subs.map(([, doc]) => doc));
}

async function idOf(path: string, under = keys): Promise<string> {
	return docIdFor(under as LiveKeys, path, 0);
}

describe("live sessions", () => {
	it("joins the room of a note open in a source editor and binds it once the room answers", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];

		await sessions.refresh();

		expect(followed()).toEqual([await idOf("a.md")]);
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalledTimes(1));
	});

	it("reports a failed refresh instead of rejecting, tells its listeners, and recovers on the next", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const good = spaceOf;
		spaceOf = () => {
			throw new Error("keys unavailable");
		};
		leaves = [{ view: editorOf(note("a.md")) }];
		const changed = vi.fn();
		sessions.subscribe(changed);

		await expect(sessions.refresh()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Live editing could not follow"),
			expect.any(Error),
		);
		expect(changed).toHaveBeenCalledTimes(1);

		spaceOf = good;
		await sessions.refresh();
		expect(followed()).toEqual([await idOf("a.md")]);
		warn.mockRestore();
	});

	it("calls a room unanswered once the hub has stayed silent for a good while", async () => {
		vi.useFakeTimers();
		try {
			connection.dropIncoming();
			leaves = [{ view: editorOf(note("a.md")) }];
			const changed = vi.fn();
			sessions.subscribe(changed);

			await sessions.refresh();
			expect(sessions.joining("a.md")).toBe(true);
			expect(sessions.noteState("a.md")).not.toBe("unanswered");

			changed.mockClear();
			await vi.advanceTimersByTimeAsync(15_000);
			expect(sessions.noteState("a.md")).toBe("unanswered");
			// No longer joining: the file sync takes the note back.
			expect(sessions.joining("a.md")).toBe(false);
			expect(changed).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("tells its listeners when each silent room runs out of patience, not only the first", async () => {
		vi.useFakeTimers();
		try {
			connection.dropIncoming();
			leaves = [{ view: editorOf(note("a.md")) }];
			await sessions.refresh();
			await vi.advanceTimersByTimeAsync(5_000);
			leaves = [...leaves, { view: editorOf(note("b.md")) }];
			await sessions.refresh();
			const changed = vi.fn();
			sessions.subscribe(changed);

			await vi.advanceTimersByTimeAsync(10_000);
			expect(sessions.noteState("a.md")).toBe("unanswered");
			expect(sessions.noteState("b.md")).not.toBe("unanswered");

			changed.mockClear();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(sessions.noteState("b.md")).toBe("unanswered");
			expect(changed).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts a room's silence from the hub coming back, not from when the note opened", async () => {
		vi.useFakeTimers();
		try {
			connection.disconnect();
			leaves = [{ view: editorOf(note("a.md")) }];
			await sessions.refresh();
			expect(sessions.spaceOf("a.md")).not.toBeNull();
			await vi.advanceTimersByTimeAsync(60_000);

			connection.listen({
				onConnectionChange: (up) => up && connection.dropIncoming(),
			});
			connection.connect();
			await sessions.refresh();
			expect(sessions.joining("a.md")).toBe(true);
			expect(sessions.noteState("a.md")).not.toBe("unanswered");

			await vi.advanceTimersByTimeAsync(15_000);
			expect(sessions.noteState("a.md")).toBe("unanswered");
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves reading view, other files, oversized and shared notes alone", async () => {
		leaves = [
			{ view: editorOf(note("read.md"), "preview") },
			{ view: editorOf(note("image.png")) },
			{ view: editorOf(note("huge.md", 300 * 1024)) },
			{ view: editorOf(note("Shared/a.md")) },
		];

		await sessions.refresh();

		expect(followed()).toEqual([]);
	});

	it("leaves the room once no editor shows the note", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());
		const detach = vi.mocked(bindEditor).mock.results[0]?.value.detach;

		leaves = [];
		await sessions.refresh();

		expect(detach).toHaveBeenCalled();
		await vi.waitFor(() => expect(followed()).toEqual([]));
	});

	it("has every room left once its disposal resolves, so the socket may close", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());

		await sessions.dispose();

		expect(followed()).toEqual([]);
	});

	it("leaves a note the hub cannot carry to the file sync, saying why, until it closes", async () => {
		for (let at = 0; at < MAX_DOC_SUBS; at++) {
			connection.send({ type: EFrame.Sub, doc: `doc-${at}`, since: 0 });
		}
		leaves = [{ view: editorOf(note("a.md")) }];

		await sessions.refresh();

		await vi.waitFor(() => expect(sessions.noteState("a.md")).toBe("too-many"));
		await sessions.refresh();
		expect(sessions.joining("a.md")).toBe(false);
		expect(bindEditor).not.toHaveBeenCalled();
		leaves = [];
		await sessions.refresh();
		expect(sessions.noteState("a.md")).toBeNull();
	});

	it("keeps a reader's note out of an empty room, and takes it in once they may write", async () => {
		const writable = spaceOf;
		spaceOf = (path) => {
			const space = writable(path);
			return space && { ...space, readOnly: true };
		};
		leaves = [{ view: editorOf(note("a.md")) }];

		await sessions.refresh();
		await vi.waitFor(() => expect(sessions.noteState("a.md")).toBe("empty"));
		spaceOf = writable;
		await sessions.refresh();

		expect(sessions.noteState("a.md")).not.toBe("empty");
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());
	});

	it("tints other people's text in every bound editor while authors are shown", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalledTimes(1));
		const first = vi.mocked(bindEditor).mock.results[0]?.value;
		expect(vi.mocked(bindEditor).mock.calls[0]?.[2]).toBeNull();

		authorsShown = true;
		sessions.repaintAuthors();
		expect(first.showAuthors).toHaveBeenCalledWith("owner");
		leaves.push({ view: editorOf(note("b.md")) });
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalledTimes(2));
		expect(vi.mocked(bindEditor).mock.calls[1]?.[2]).toBe("owner");

		authorsShown = false;
		sessions.repaintAuthors();
		expect(first.showAuthors).toHaveBeenLastCalledWith(null);
	});

	it("stays out without keys and moves every note to new rooms when they change", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];
		const first = keys;
		keys = null;
		await sessions.refresh();
		expect(followed()).toEqual([]);

		keys = first;
		await sessions.refresh();
		keys = await freshKeys();
		await sessions.refresh();

		const next = await idOf("a.md");
		await vi.waitFor(() => expect(followed()).toEqual([next]));
	});

	it("takes a shared note into its share's room, named by its path inside the share", async () => {
		const team: LiveSpace = {
			id: "team",
			root: "Shared/Team",
			keys: await freshKeys(),
			person: "p1",
			user: USER,
		};
		leaves = [{ view: editorOf(note("Shared/Team/a.md")) }];
		spaceOf = () => vault();
		await sessions.refresh();
		expect(followed()).toEqual([await idOf("Shared/Team/a.md")]);

		// The folder became a share: the note leaves the vault's room for the share's.
		spaceOf = () => team;
		await sessions.refresh();

		const inShare = await docIdFor(team.keys, "a.md", 0);
		await vi.waitFor(() => expect(followed()).toEqual([inShare]));
		expect(sessions.spaceOf("Shared/Team/a.md")).toBe("team");
	});
});

describe("live notes as the file sync sees them", () => {
	const cold = (space = "vault") =>
		new LiveColdSync({
			rooms: sessions,
			agreed,
			space,
			live: async () => vault(),
			kept: () => undefined,
		});

	function hashOf(text: string): Promise<string> {
		return sha256Hex(new TextEncoder().encode(text));
	}

	/** Opens a.md, whose editor holds "text", and waits for its room. */
	async function openRoom(): Promise<{
		room: LiveSession<TextModel>;
		view: MarkdownView;
	}> {
		const view = editorOf(note("a.md"));
		leaves = [{ view }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());
		return { room: sessions.roomOf("a.md") as LiveSession<TextModel>, view };
	}

	it("marks a closed note's file that is its room's agreed text", async () => {
		const doc = await idOf("a.md");
		agreed.put(doc, { text: "x", gen: 2, seq: 3 });

		expect(await cold().mark("a.md", await hashOf("x"))).toEqual({
			doc,
			gen: 2,
			seq: 3,
		});
		expect(await cold().mark("a.md", await hashOf("y"))).toBeNull();
	});

	it("derives no id for a pushed note while no note ever went live", async () => {
		const sign = vi.spyOn(crypto.subtle, "sign");

		expect(await cold().mark("never-live.md", await hashOf("x"))).toBeNull();

		expect(sign).not.toHaveBeenCalled();
		sign.mockRestore();
	});

	it("holds an open note back until its room has settled on the file", async () => {
		const { room } = await openRoom();
		await vi.waitFor(async () =>
			expect(await agreed.get(room.docId)).toEqual({
				text: "text",
				gen: 0,
				seq: 1,
			}),
		);
		expect(await cold().mark("a.md", await hashOf("text"))).toEqual({
			doc: room.docId,
			gen: 0,
			seq: 1,
		});

		room.model.text.insert(0, "typed ");

		expect(await cold().mark("a.md", await hashOf("text"))).toBe("later");
	});

	it("folds an incoming version into the open room and saves it", async () => {
		const { room, view } = await openRoom();

		const take = await cold().absorb("a.md", undefined, async () => ({
			base: "text",
			incoming: "text\nmore",
		}));

		expect(take).toBe("taken");
		expect(room.model.text.toString()).toBe("text\nmore");
		expect(view.save).toHaveBeenCalled();
	});

	it("leaves a reader's note to the file sync at a version its room lacks", async () => {
		await openRoom();
		leaves = [];
		await sessions.refresh();
		const writable = spaceOf;
		spaceOf = (path) => {
			const space = writable(path);
			return space && { ...space, readOnly: true };
		};
		vi.mocked(bindEditor).mockClear();
		const { room } = await openRoom();
		expect(room).toBeInstanceOf(FollowerSession);
		const offer = (incoming: string) =>
			cold().absorb("a.md", undefined, async () => ({
				base: "text",
				incoming,
			}));

		expect(await offer("text")).toBe("taken");
		expect(await offer("text\nmore")).toBe("later");

		expect(room.model.text.toString()).toBe("text");
		await vi.waitFor(() => expect(sessions.noteState("a.md")).toBe("diverged"));
	});

	it("leaves an incoming version for later when its view cannot save", async () => {
		const { view } = await openRoom();
		Object.assign(view, { getMode: () => "preview" });

		const take = await cold().absorb("a.md", undefined, async () => ({
			base: "text",
			incoming: "text\nmore",
		}));

		expect(take).toBe("later");
	});

	it("leaves an incoming version for later when its room closed while it was fetched", async () => {
		const { room } = await openRoom();

		const take = await cold().absorb("a.md", undefined, async () => {
			leaves = [];
			await sessions.refresh();
			return { base: "text", incoming: "text\nmore" };
		});

		expect(take).toBe("later");
		expect(room.model.text.toString()).toBe("text");
	});

	it("waits for its own room to catch up with a snapshot of it", async () => {
		const { room } = await openRoom();
		const texts = vi.fn(async () => ({ base: "text", incoming: "text\nmore" }));

		const snapshot = (gen: number, seq: number) =>
			cold().absorb("a.md", { doc: room.docId, gen, seq }, texts);

		const takes = [
			await snapshot(0, 9),
			await snapshot(1, 1),
			await snapshot(0, room.seq),
		];

		expect(takes).toEqual(["later", "later", "taken"]);
		expect(texts).not.toHaveBeenCalled();
		expect(room.model.text.toString()).toBe("text");
	});

	it("holds a note open in another space's room until this sync's partition catches up", async () => {
		await openRoom();
		const texts = vi.fn();

		expect(await cold("team").absorb("a.md", undefined, texts)).toBe("later");
		expect(await cold("team").mark("a.md", await hashOf("text"))).toBe("later");
		expect(texts).not.toHaveBeenCalled();
	});

	it("leaves a closed note to the file sync, and its views ready for the write", async () => {
		const expectWrite = vi.spyOn(sessions, "expectWrite");

		expect(await cold().absorb("b.md", undefined, vi.fn())).toBe("cold");
		expect(expectWrite).toHaveBeenCalledWith("b.md");
	});

	it("holds the file while an open note's room is still answering", async () => {
		connection.dropIncoming();
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();

		expect(await cold().absorb("a.md", undefined, vi.fn())).toBe("later");
		expect(await cold().mark("a.md", await hashOf("text"))).toBe("later");
	});

	it("leaves an open note to the file sync while the hub is down", async () => {
		connection.disconnect();
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();

		expect(await cold().absorb("a.md", undefined, vi.fn())).toBe("cold");
	});

	it("makes a snapshot the file sync wrote the merge base of its note", async () => {
		const doc = await idOf("a.md");

		await cold().wrote("a.md", { doc, gen: 1, seq: 4 }, "pulled\r\n");
		await cold().wrote("a.md", { doc: "another", gen: 1, seq: 9 }, "foreign");

		expect(await agreed.get(doc)).toEqual({ text: "pulled\n", gen: 1, seq: 4 });
	});
});

describe("rebuilt rooms", () => {
	async function bound(): Promise<LiveSession<TextModel>> {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(sessions.roomOf("a.md")).not.toBeNull());
		return sessions.roomOf("a.md") as LiveSession<TextModel>;
	}

	it("moves an open note's editor into the successor of its room", async () => {
		const first = await bound();
		const detach = vi.mocked(bindEditor).mock.results[0]?.value.detach;
		await vi.waitFor(() => expect(first.settled).toBe(true));

		expect(await sessions.rotate("a.md")).toBe("moved");

		const next = await docIdFor(keys as LiveKeys, "a.md", 1);
		await vi.waitFor(() => expect(sessions.roomOf("a.md")?.docId).toBe(next));
		expect(detach).toHaveBeenCalled();
		expect(bindEditor).toHaveBeenCalledTimes(2);
		expect(followed()).toEqual([next]);
		await vi.waitFor(async () =>
			expect(await agreed.get(await idOf("a.md"))).toMatchObject({ gen: 1 }),
		);
	});

	it("rebuilds a shared note under its share's key and inner path", async () => {
		const team: LiveSpace = {
			id: "team",
			root: "Shared",
			keys: await freshKeys(),
			person: "p1",
			user: USER,
		};
		spaceOf = () => team;
		leaves = [{ view: editorOf(note("Shared/a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() =>
			expect(sessions.roomOf("Shared/a.md")?.settled).toBe(true),
		);

		expect(await sessions.rotate("Shared/a.md")).toBe("moved");

		const next = await docIdFor(team.keys, "a.md", 1);
		await vi.waitFor(() =>
			expect(sessions.roomOf("Shared/a.md")?.docId).toBe(next),
		);
	});

	it("moves an open note on when the hub lost its room", async () => {
		const first = await bound();
		await vi.waitFor(() => expect(first.settled).toBe(true));

		hub.wipe();
		connection.connect();

		const next = await docIdFor(keys as LiveKeys, "a.md", 1);
		await vi.waitFor(() => expect(sessions.roomOf("a.md")?.docId).toBe(next));
		expect(followed()).toEqual([next]);
		await vi.waitFor(async () =>
			expect(await agreed.get(await idOf("a.md"))).toMatchObject({ gen: 1 }),
		);
	});

	it("reopens a note in the generation it last agreed on", async () => {
		const third = await docIdFor(keys as LiveKeys, "a.md", 2);
		agreed.put(await idOf("a.md"), { text: "text", gen: 2, seq: 1 });
		const raw = hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, doc: third, since: 0 });
		raw.send({
			type: EFrame.Update,
			n: 1,
			doc: third,
			payload: await seal(
				keys as LiveKeys,
				Uint8Array.of(0, 0),
				`doc:${third}`,
			),
		});
		raw.disconnect();

		await bound();

		expect(followed()).toEqual([third]);
	});

	it("leaves a note to the file sync when its room points anywhere but its next generation", async () => {
		const room = await bound();
		const raw = hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, doc: room.docId, since: 0 });
		raw.send({
			type: EFrame.Rotate,
			doc: room.docId,
			target: "f".repeat(32),
			upto: room.seq,
			note: new Uint8Array(),
			payload: await seal(
				keys as LiveKeys,
				Uint8Array.of(0, 0),
				`doc:${"f".repeat(32)}`,
			),
		});
		raw.disconnect();

		await vi.waitFor(() => expect(followed()).toEqual([]));
		await sessions.refresh();
		expect(followed()).toEqual([]);
		expect(sessions.joining("a.md")).toBe(false);
	});
});
