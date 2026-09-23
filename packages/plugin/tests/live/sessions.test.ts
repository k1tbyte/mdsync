import { EFrame } from "@obsync/protocol";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { LiveHub, type TestConnection } from "@tests/helpers/live-hub";
import { type App, type DataAdapter, MarkdownView, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "@/crypto";
import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { VAULT_SLOT } from "@/hub/connection";
import { AgreedTexts } from "@/live/agreed-texts";
import { bindEditor } from "@/live/binding";
import { LiveColdSync } from "@/live/cold-sync";
import { docIdFor, seal } from "@/live/seal";
import type { LiveSession } from "@/live/session";
import { LiveSessions } from "@/live/sessions";

vi.mock("@/live/binding", () => ({ bindEditor: vi.fn(() => vi.fn()) }));

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
let leaves: { view: MarkdownView }[];
let agreed: AgreedTexts;
let sessions: LiveSessions;

beforeEach(async () => {
	vi.mocked(bindEditor).mockClear();
	hub = new LiveHub();
	connection = hub.connection();
	connection.connect();
	keys = await freshKeys();
	leaves = [];
	agreed = new AgreedTexts(
		new InMemoryAdapter() as unknown as DataAdapter,
		".obsidian",
	);
	sessions = new LiveSessions({
		app: fakeApp(),
		hub: connection,
		keys: async () => keys,
		user: () => ({ name: "laptop", color: "red", colorLight: "pink" }),
		agreed,
		baseText: async () => null,
	});
});

afterEach(() => sessions.dispose());

function fakeApp(): App {
	return {
		workspace: { getLeavesOfType: () => leaves },
		vault: { getFileByPath: () => null, read: async () => "" },
		metadataCache: { getFileCache: () => null },
	} as unknown as App;
}

function note(path: string, size = 10): TFile {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		stat: { size },
	});
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

	it("leaves reading view, other files and oversized notes alone", async () => {
		leaves = [
			{ view: editorOf(note("read.md"), "preview") },
			{ view: editorOf(note("image.png")) },
			{ view: editorOf(note("huge.md", 300 * 1024)) },
		];

		await sessions.refresh();

		expect(followed()).toEqual([]);
	});

	it("leaves the room once no editor shows the note", async () => {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());
		const detach = vi.mocked(bindEditor).mock.results[0]?.value;

		leaves = [];
		await sessions.refresh();

		expect(detach).toHaveBeenCalled();
		await vi.waitFor(() => expect(followed()).toEqual([]));
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
});

describe("live notes as the file sync sees them", () => {
	const cold = () =>
		new LiveColdSync({ rooms: sessions, agreed, keys: async () => keys });

	function hashOf(text: string): Promise<string> {
		return sha256Hex(new TextEncoder().encode(text));
	}

	/** Opens a.md, whose editor holds "text", and waits for its room. */
	async function openRoom(): Promise<{
		room: LiveSession;
		view: MarkdownView;
	}> {
		const view = editorOf(note("a.md"));
		leaves = [{ view }];
		await sessions.refresh();
		await vi.waitFor(() => expect(bindEditor).toHaveBeenCalled());
		return { room: sessions.roomOf("a.md") as LiveSession, view };
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

		room.text.insert(0, "typed ");

		expect(await cold().mark("a.md", await hashOf("text"))).toBe("later");
	});

	it("folds an incoming version into the open room and saves it", async () => {
		const { room, view } = await openRoom();

		const take = await cold().absorb("a.md", undefined, async () => ({
			base: "text",
			incoming: "text\nmore",
		}));

		expect(take).toBe("taken");
		expect(room.text.toString()).toBe("text\nmore");
		expect(view.save).toHaveBeenCalled();
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
		expect(room.text.toString()).toBe("text");
	});

	it("leaves a closed note to the file sync", async () => {
		expect(await cold().absorb("b.md", undefined, vi.fn())).toBe("cold");
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
	async function bound(): Promise<LiveSession> {
		leaves = [{ view: editorOf(note("a.md")) }];
		await sessions.refresh();
		await vi.waitFor(() => expect(sessions.roomOf("a.md")).not.toBeNull());
		return sessions.roomOf("a.md") as LiveSession;
	}

	it("moves an open note's editor into the successor of its room", async () => {
		const first = await bound();
		const detach = vi.mocked(bindEditor).mock.results[0]?.value;
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

	it("reopens a note in the generation it last agreed on", async () => {
		agreed.put(await idOf("a.md"), { text: "text", gen: 2, seq: 1 });

		await bound();

		expect(followed()).toEqual([await docIdFor(keys as LiveKeys, "a.md", 2)]);
	});

	it("leaves a note to the file sync when its room points anywhere but its next generation", async () => {
		const room = await bound();
		const raw = hub.connection();
		raw.connect();
		raw.send({ type: EFrame.Sub, slot: VAULT_SLOT, doc: room.docId, since: 0 });
		raw.send({
			type: EFrame.Rotate,
			slot: VAULT_SLOT,
			doc: room.docId,
			target: "f".repeat(32),
			upto: room.seq,
			payload: await seal(keys as LiveKeys, Uint8Array.of(0, 0)),
		});
		raw.disconnect();

		await vi.waitFor(() => expect(followed()).toEqual([]));
		await sessions.refresh();
		expect(followed()).toEqual([]);
		expect(sessions.joining("a.md")).toBe(false);
	});
});
