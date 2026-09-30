import { EFrame } from "@obsync/protocol";
import { InMemoryAdapter } from "@tests/helpers/in-memory-adapter";
import { LiveHub } from "@tests/helpers/live-hub";
import { type App, type DataAdapter, MarkdownView, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveLiveKeys, type LiveKeys } from "@/crypto/live-keys";
import { AgreedTexts } from "@/live/agreed-texts";
import { movedWith } from "@/live/rename";
import { docIdFor, seal } from "@/live/seal";
import type { LiveSession } from "@/live/session";
import { LiveSessions } from "@/live/sessions";
import type { LiveSpace } from "@/live/space";
import type { TextModel } from "@/live/text/model";

vi.mock("@/live/text/binding", () => ({
	bindEditor: vi.fn(() => ({ detach: vi.fn(), showAuthors: vi.fn() })),
}));

const USER = { key: "d1", name: "laptop", color: "red" };
const encoder = new TextEncoder();

let hub: LiveHub;
let keys: LiveKeys;
let devices: Device[];

beforeEach(async () => {
	hub = new LiveHub();
	keys = await deriveLiveKeys(crypto.getRandomValues(new Uint8Array(32)));
	devices = [];
});

afterEach(() => {
	for (const { sessions } of devices) sessions.dispose();
});

/** A device with one note open in a source editor, on its own socket. */
class Device {
	readonly file: TFile;
	readonly agreed = new AgreedTexts(
		new InMemoryAdapter() as unknown as DataAdapter,
		".obsidian",
	);
	/** The cold sync's baseline per path. */
	readonly baselines = new Map<string, string>();
	/** As `vault.rename`: the TFile keeps its identity, and its rename event refreshes. */
	readonly moveFile = vi.fn(async (from: string, to: string) => {
		if (this.file.path !== from) return false;
		this.rename(to);
		return true;
	});
	readonly sessions: LiveSessions;
	readonly connection = hub.connection();

	constructor(path: string, space: LiveSpace) {
		this.file = Object.assign(new TFile(), {
			path,
			extension: "md",
			stat: { size: 10 },
		});
		const view = Object.assign(Object.create(MarkdownView.prototype), {
			file: this.file,
			getMode: () => "source",
			editor: { getValue: () => "text" },
			save: vi.fn(async () => undefined),
		});
		this.connection.connect();
		this.sessions = new LiveSessions({
			app: {
				workspace: {
					getLeavesOfType: (type: string) =>
						type === "markdown" ? [{ view }] : [],
				},
				vault: { getFileByPath: () => null, read: async () => "" },
				metadataCache: { getFileCache: () => ({}) },
			} as unknown as App,
			hub: this.connection,
			liveSpace: async () => space,
			agreed: this.agreed,
			baseText: async (path) => this.baselines.get(path) ?? null,
			moveFile: this.moveFile,
			authorsShown: () => false,
			nameOf: () => null,
		});
	}

	rename(to: string): void {
		this.file.path = to;
		void this.sessions.refresh();
	}

	roomAt(path = this.file.path): string | undefined {
		return this.sessions.roomOf(path)?.docId;
	}

	text(): string {
		const room = this.sessions.roomOf(this.file.path);
		return (room as LiveSession<TextModel>).model.text.toString();
	}
}

function vault(): LiveSpace {
	return { id: "vault", root: "", keys, person: "owner", user: USER };
}

/** A device whose note is open and settled in its room. */
async function device(path: string): Promise<Device> {
	const opened = new Device(path, vault());
	devices.push(opened);
	await opened.sessions.refresh();
	await vi.waitFor(() =>
		expect(opened.sessions.roomOf(path)?.settled).toBe(true),
	);
	return opened;
}

function idOf(path: string, generation = 0): Promise<string> {
	return docIdFor(keys, path, generation);
}

/** Another note's room, as a note once open at that path left it. */
async function occupy(doc: string): Promise<void> {
	const raw = hub.connection();
	raw.connect();
	raw.send({ type: EFrame.Sub, doc, since: 0 });
	const payload = await seal(keys, Uint8Array.of(0, 0), `doc:${doc}`);
	raw.send({ type: EFrame.Update, doc, payload });
	raw.disconnect();
}

describe("renaming a live note", () => {
	it("takes the room along, and the other device renames its file and follows", async () => {
		const laptop = await device("a.md");
		const desktop = await device("a.md");
		const moved = await idOf("b.md");

		laptop.rename("b.md");

		await vi.waitFor(() => expect(laptop.roomAt()).toBe(moved));
		await vi.waitFor(() => expect(desktop.roomAt("b.md")).toBe(moved));
		expect(desktop.moveFile).toHaveBeenCalledWith("a.md", "b.md");
		expect(laptop.moveFile).not.toHaveBeenCalled();
		// The merge base went along: reopened, the note starts from it.
		expect(await desktop.agreed.get(moved)).toMatchObject({ gen: 0 });
		// One room: an edit on one device reaches the other.
		const room = laptop.sessions.roomOf("b.md") as LiveSession<TextModel>;
		room.model.text.insert(0, "both ");
		await vi.waitFor(() => expect(desktop.text()).toBe("both text"));
	});

	it("waits as joining while the room moves, so the file sync leaves the note be", async () => {
		const laptop = await device("a.md");
		laptop.connection.dropIncoming();

		laptop.rename("b.md");

		await vi.waitFor(() =>
			expect(laptop.sessions.spaceOf("b.md")).not.toBeNull(),
		);
		expect(laptop.sessions.roomOf("b.md")).toBeNull();
		expect(laptop.sessions.joining("b.md")).toBe(true);
	});

	it("carries the cold baseline as the merge base when nothing was agreed", async () => {
		const laptop = await device("a.md");
		const desktop = await device("a.md");
		const room = laptop.sessions.roomOf("a.md") as LiveSession<TextModel>;
		room.model.text.insert(0, "both ");
		await vi.waitFor(() => expect(desktop.text()).toBe("both text"));
		// Never agreed here: only the baseline knows what the disk grew from.
		const first = await idOf("a.md");
		const agreed = desktop.agreed.get.bind(desktop.agreed);
		vi.spyOn(desktop.agreed, "get").mockImplementation(async (doc) =>
			doc === first ? null : agreed(doc),
		);
		desktop.baselines.set("a.md", "text");
		const moved = await idOf("b.md");

		laptop.rename("b.md");

		await vi.waitFor(() => expect(desktop.roomAt("b.md")).toBe(moved));
		expect(desktop.text()).toBe("both text");
	});

	it("leaves the room where it is when the new path's room holds another note", async () => {
		const taken = await idOf("b.md");
		await occupy(taken);
		const laptop = await device("a.md");
		const desktop = await device("a.md");
		const before = desktop.roomAt();

		laptop.rename("b.md");

		await vi.waitFor(() => expect(laptop.roomAt()).toBe(taken));
		expect(desktop.roomAt()).toBe(before);
		expect(desktop.moveFile).not.toHaveBeenCalled();
	});

	it("renames back into a fresh generation past its old room's pointer", async () => {
		const laptop = await device("a.md");
		const desktop = await device("a.md");
		laptop.rename("b.md");
		await vi.waitFor(() => expect(desktop.file.path).toBe("b.md"));
		await vi.waitFor(() =>
			expect(laptop.sessions.roomOf("b.md")?.settled).toBe(true),
		);
		const back = await idOf("a.md", 1);

		laptop.rename("a.md");

		await vi.waitFor(() => expect(laptop.roomAt()).toBe(back));
		await vi.waitFor(() => expect(desktop.roomAt("a.md")).toBe(back));
		expect(desktop.file.path).toBe("a.md");
	});

	it("gives a new note where one was renamed away a room of its own", async () => {
		const laptop = await device("a.md");
		const moved = await idOf("b.md");
		laptop.rename("b.md");
		await vi.waitFor(() => expect(laptop.roomAt()).toBe(moved));

		const newcomer = await device("a.md");

		expect(newcomer.roomAt()).toBe(await idOf("a.md", 1));
		expect(newcomer.moveFile).not.toHaveBeenCalled();
	});

	it("settles two renames at once on the one the hub took first", async () => {
		const laptop = await device("a.md");
		const desktop = await device("a.md");

		laptop.rename("b.md");
		desktop.rename("c.md");

		await vi.waitFor(() => {
			expect(laptop.file.path).toBe(desktop.file.path);
			expect(laptop.roomAt()).toBeDefined();
			expect(laptop.roomAt()).toBe(desktop.roomAt());
		});
		expect(["b.md", "c.md"]).toContain(laptop.file.path);
	});
});

describe("move notes", () => {
	async function movedAs(
		note: unknown,
		target: string,
		space: LiveSpace = vault(),
		from = "from",
	): Promise<unknown> {
		const bytes = encoder.encode(JSON.stringify(note));
		const session = {
			docId: "from",
			movedTo: target,
			moveNote: await seal(keys, bytes, `moved:${from}`),
		} as unknown as LiveSession;
		return movedWith(space, session);
	}

	it("names the room it points at, under the space's mount", async () => {
		const shared = { ...vault(), root: "Shared" };
		const target = await idOf("notes/x.md", 2);

		expect(
			await movedAs({ path: "notes/x.md", generation: 2 }, target, shared),
		).toEqual({ path: "Shared/notes/x.md", generation: 2 });
	});

	it("refuses a path out of the space's notes, another room, or a note sealed for another", async () => {
		for (const path of [
			"../x.md",
			".obsidian/x.md",
			"a//x.md",
			"x.txt",
			"a\\x.md",
		]) {
			const target = await idOf(path);
			expect(await movedAs({ path, generation: 0 }, target), path).toBeNull();
		}
		const note = { path: "x.md", generation: 0 };
		expect(await movedAs(note, await idOf("y.md"))).toBeNull();
		expect(
			await movedAs(note, await idOf("x.md"), vault(), "other"),
		).toBeNull();
		expect(
			await movedAs({ path: "x.md", generation: -1 }, await idOf("x.md", -1)),
		).toBeNull();
	});
});
