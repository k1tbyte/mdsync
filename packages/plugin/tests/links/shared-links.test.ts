import { FakeStorage } from "@tests/helpers/fake-storage";
import { link, linkDevice, linkId } from "@tests/helpers/shared-links";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	decryptJson,
	deriveKey,
	type EncryptionKey,
	encryptJson,
} from "@/crypto";
import { noteLinks, noteLinksText } from "@/links/note-links";
import type { StoredLink } from "@/links/record";
import { SharedLinks } from "@/links/shared-links";
import type { PluginHost } from "@/plugin/host";

const PUBLISHED = 1_760_000_000_000;
const VAULT = "vault";

let key: EncryptionKey;

beforeAll(async () => {
	key = await deriveKey("vault", new Uint8Array(16));
});

function store(links: StoredLink[], author?: string) {
	const device = linkDevice(links, author);
	const listener = vi.fn();
	device.shared.subscribe(listener);
	return { ...device, listener };
}

/** Holds every listing until opened, so a trade stays in flight. */
class Held extends FakeStorage {
	open: () => void = () => {};
	private gate = new Promise<void>((resolve) => {
		this.open = resolve;
	});

	override async list(prefix: string): Promise<string[]> {
		await this.gate;
		return super.list(prefix);
	}
}

const objectName = (seed: string) => `links/${linkId(seed)}.json.enc`;

describe("SharedLinks", () => {
	it("detaches a note or folder and excludes its links from of", async () => {
		const a = link("a", "d/x.md");
		const b = link("b", "d/sub/y.md");
		const other = link("c", "different/z.md");
		const { shared, save, listener } = store([a, b, other]);
		await shared.detach(a.path);
		expect(shared.of(a.path)).toEqual([]);
		expect(shared.all()).toEqual([{ ...a, detached: true, rev: 1 }, b, other]);
		await shared.detach("d");
		expect(shared.of(b.path)).toEqual([]);
		expect(shared.all()).toEqual([
			{ ...a, detached: true, rev: 1 },
			{ ...b, detached: true, rev: 1 },
			other,
		]);
		await shared.detach("d");
		expect(save).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("saves and tells subscribers on every change, announcing adds and removals", async () => {
		const { settings, save, listener, announce, shared } = store([
			link("a", "x.md"),
		]);

		await shared.add(link("b", "x.md"));
		await shared.published(linkId("a"), PUBLISHED + 5);
		await shared.remove(linkId("b"));

		expect(settings.links).toEqual([
			link("a", "x.md", { publishedAt: PUBLISHED + 5, rev: 1 }),
			link("b", "x.md", { rev: 1, removed: true }),
		]);
		expect(shared.all()).toEqual([settings.links[0]]);
		expect(save).toHaveBeenCalledTimes(3);
		expect(listener).toHaveBeenCalledTimes(3);
		expect(announce).toHaveBeenCalledTimes(2);
	});

	it("signs every edit as a new revision by this device", async () => {
		const { settings, shared } = store(
			[link("a", "d/x.md", { rev: 4 }), link("b", "y.md")],
			"phone",
		);

		const added = await shared.add(link("c", "z.md", { rev: 7 }));
		await shared.move("d", "e");

		expect(added).toMatchObject({ rev: 0, author: "phone" });
		expect(settings.links.map(({ rev, author }) => [rev, author])).toEqual([
			[5, "phone"],
			[0, "laptop"],
			[0, "phone"],
		]);
	});

	it("moves links with their note and ignores unrelated renames", async () => {
		const { settings, save, listener, shared } = store([link("a", "d/x.md")]);

		await shared.move("other.md", "else.md");
		expect(save).not.toHaveBeenCalled();

		await shared.move("d", "e");
		expect(settings.links[0]?.path).toBe("e/x.md");
		expect(shared.of("e/x.md")).toHaveLength(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("hides a traded link at once and keeps it until a trade deletes it", async () => {
		const traded = link("a", "x.md", { vault: VAULT });
		const { settings, shared } = store([traded]);

		await shared.remove(traded.id);

		expect(shared.all()).toEqual([]);
		expect(shared.of("x.md")).toEqual([]);
		expect(settings.links).toEqual([{ ...traded, rev: 1, removed: true }]);
	});

	it("lets any device of the vault list and revoke a link another one made", async () => {
		const storage = new FakeStorage(VAULT);
		const laptop = linkDevice();
		const phone = linkDevice([], "phone");

		const made = await laptop.shared.add(link("a"));
		expect(await laptop.shared.sync(storage, key)).toBe(true);
		expect(await phone.shared.sync(storage, key)).toBe(false);
		expect(phone.shared.all()).toEqual([{ ...made, vault: VAULT }]);

		await phone.shared.remove(made.id);
		expect(phone.announce).toHaveBeenCalledOnce();
		expect(await phone.shared.sync(storage, key)).toBe(true);
		expect(storage.map.size).toBe(0);
		expect(phone.settings.links).toEqual([]);

		expect(await laptop.shared.sync(storage, key)).toBe(false);
		expect(laptop.settings.links).toEqual([]);
	});

	it("saves only when a trade changed the list", async () => {
		const storage = new FakeStorage(VAULT);
		const { save, shared } = linkDevice([link("a")]);
		await shared.sync(storage, key);
		save.mockClear();

		expect(await shared.sync(storage, key)).toBe(false);
		expect(save).not.toHaveBeenCalled();
	});

	it("replays an edit made during a trade above the revision the trade took in", async () => {
		const storage = new Held(VAULT);
		const theirs = link("a", "a.md", { rev: 3, author: "phone" });
		await storage.put(objectName("a"), await encryptJson(key, theirs));
		const { settings, shared } = linkDevice([
			link("a", "a.md", { vault: VAULT }),
		]);

		const trading = shared.sync(storage, key);
		await shared.published(linkId("a"), PUBLISHED + 5);
		expect(await shared.sync(storage, key)).toBe(false);
		expect(settings.links[0]).toMatchObject({
			rev: 1,
			publishedAt: PUBLISHED + 5,
		});
		storage.open();
		await trading;

		const replayed = {
			...theirs,
			rev: 4,
			author: "laptop",
			publishedAt: PUBLISHED + 5,
		};
		expect(settings.links).toEqual([{ ...replayed, vault: VAULT }]);
		expect(await shared.sync(storage, key)).toBe(true);
		const body = storage.map.get(objectName("a"));
		expect(body && (await decryptJson(key, body))).toEqual(replayed);
	});

	it("replays a rename during a trade onto a link the trade brings in", async () => {
		const storage = new Held(VAULT);
		const theirs = link("a", "x.md", { author: "phone" });
		await storage.put(objectName("a"), await encryptJson(key, theirs));
		const { settings, save, shared } = linkDevice();

		const trading = shared.sync(storage, key);
		await shared.move("x.md", "y.md");
		expect(save).not.toHaveBeenCalled();
		storage.open();
		await trading;

		expect(settings.links).toEqual([
			{ ...theirs, path: "y.md", rev: 1, author: "laptop", vault: VAULT },
		]);
	});

	it("still deletes links a failed trade wrote, removed during or after it", async () => {
		const storage = new Held(VAULT);
		const failure = new Error("offline");
		const put = storage.put.bind(storage);
		vi.spyOn(storage, "put").mockImplementation((name, body) =>
			name === objectName("b") ? Promise.reject(failure) : put(name, body),
		);
		const { settings, shared } = linkDevice([link("a"), link("c"), link("b")]);

		const trading = shared.sync(storage, key);
		await shared.remove(linkId("a"));
		storage.open();
		await expect(trading).rejects.toBe(failure);
		await shared.remove(linkId("c"));
		expect(storage.map.has(objectName("a"))).toBe(true);
		expect(storage.map.has(objectName("c"))).toBe(true);
		expect(shared.all()).toEqual([link("b")]);

		vi.mocked(storage.put).mockImplementation(put);
		await shared.sync(storage, key);

		expect([...storage.map.keys()]).toEqual([objectName("b")]);
		expect(settings.links).toEqual([{ ...link("b"), vault: VAULT }]);
	});

	it("tells subscribers when a link expires, while anyone listens", () => {
		vi.useFakeTimers({ now: PUBLISHED });
		try {
			const soon = link("a", "x.md", { expires: PUBLISHED / 1000 + 60 });
			const { listener } = store([soon]);
			vi.advanceTimersByTime(60_000);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);

			const later = link("b", "x.md", { expires: PUBLISHED / 1000 + 600 });
			const { shared: idle } = linkDevice([later]);
			const unsubscribe = idle.subscribe(() => {});
			expect(vi.getTimerCount()).toBe(1);
			unsubscribe();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads the settings object current at each call", async () => {
		let settings = { links: [link("a", "x.md")] };
		const shared = new SharedLinks({
			settings: () => settings,
			save: async () => {},
			author: () => "laptop",
			announce: () => {},
		});
		settings = { links: [] };
		expect(shared.all()).toEqual([]);
		await shared.add(link("b", "y.md"));
		expect(settings.links).toHaveLength(1);
	});
});

describe("noteLinks", () => {
	function host(links: StoredLink[], mtime: number) {
		const { shared } = store(links);
		return {
			sharedLinks: shared,
			app: { vault: { getFileByPath: () => ({ stat: { mtime } }) } },
		} as unknown as PluginHost;
	}

	it("is null for a note without live links", () => {
		const expired = link("a", "x.md", { expires: 1 });
		expect(noteLinks(host([expired], PUBLISHED), "x.md")).toBeNull();
		expect(noteLinks(host([], PUBLISHED), "x.md")).toBeNull();
	});

	it("is stale once the note changed after a publish", () => {
		const links = [link("a", "x.md"), link("b", "x.md")];
		expect(noteLinks(host(links, PUBLISHED), "x.md")?.stale).toBe(false);
		const changed = noteLinks(host(links, PUBLISHED + 1), "x.md");
		expect(changed).toMatchObject({ stale: true });
		expect(changed && noteLinksText(changed)).toBe(
			"Shared by 2 links. Changed since it was shared: click to update.",
		);
	});

	it("names the expiry of a single link", () => {
		const links = noteLinks(host([link("a", "x.md")], PUBLISHED), "x.md");
		expect(links && noteLinksText(links)).toBe(
			"Shared by link. Never expires. Click to manage.",
		);
	});
});
