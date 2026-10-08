import { describe, expect, it, vi } from "vitest";

import { noteLinks, noteLinksText } from "@/links/note-links";
import type { LinkRecord } from "@/links/record";
import { SharedLinks } from "@/links/shared-links";
import type { PluginHost } from "@/plugin/host";

const PUBLISHED = 1_760_000_000_000;

function link(id: string, path: string, extra?: Partial<LinkRecord>) {
	return {
		id,
		url: `https://relay.example/s/${id}#key`,
		path,
		title: "Note",
		createdAt: PUBLISHED,
		publishedAt: PUBLISHED,
		expires: null,
		maxViews: null,
		salt: null,
		images: true,
		...extra,
	} satisfies LinkRecord;
}

function store(links: LinkRecord[]) {
	const settings = { links };
	const save = vi.fn(async () => {});
	const listener = vi.fn();
	const shared = new SharedLinks(() => settings, save);
	shared.subscribe(listener);
	return { settings, save, listener, shared };
}

describe("SharedLinks", () => {
	it("saves and tells subscribers on every change", async () => {
		const { settings, save, listener, shared } = store([link("a", "x.md")]);

		await shared.add(link("b", "x.md"));
		await shared.published("a", PUBLISHED + 5);
		await shared.remove("b");

		expect(settings.links).toEqual([
			link("a", "x.md", { publishedAt: PUBLISHED + 5 }),
		]);
		expect(save).toHaveBeenCalledTimes(3);
		expect(listener).toHaveBeenCalledTimes(3);
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

	it("tells subscribers when a link expires, while anyone listens", () => {
		vi.useFakeTimers({ now: PUBLISHED });
		try {
			const soon = link("a", "x.md", { expires: PUBLISHED / 1000 + 60 });
			const { listener } = store([soon]);
			vi.advanceTimersByTime(60_000);
			expect(listener).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);

			const later = link("b", "x.md", { expires: PUBLISHED / 1000 + 600 });
			const idle = new SharedLinks(
				() => ({ links: [later] }),
				async () => {},
			);
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
		const shared = new SharedLinks(
			() => settings,
			async () => {},
		);
		settings = { links: [] };
		expect(shared.all()).toEqual([]);
		await shared.add(link("b", "y.md"));
		expect(settings.links).toHaveLength(1);
	});
});

describe("noteLinks", () => {
	function host(links: LinkRecord[], mtime: number) {
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
