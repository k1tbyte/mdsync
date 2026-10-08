import { randomBytes } from "node:crypto";
import {
	deriveLinkKeys,
	fromBase64Url,
	LINK_GATE_PATTERN,
	LINK_MAX_SEALED_BYTES,
	linkUrl,
	newLinkId,
	newLinkKey,
	newLinkSalt,
	openLinkPayload,
	parseLinkLocation,
	toBase64Url,
} from "@mdsync/protocol";
import { TFile } from "obsidian";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { noteText } from "@/links/note-text";
import {
	linkStatusOf,
	publishLink,
	revokeLinkRecord,
	type ShareOptions,
	TOO_LARGE,
	updateLink,
} from "@/links/publish";
import type { LinkRecord } from "@/links/record";
import { SharedLinks } from "@/links/shared-links";
import { type Snapshot, takeSnapshot } from "@/links/snapshot";
import type { PluginHost } from "@/plugin/host";
import { linkStatus, putLink, revokeLink } from "@/storage";

vi.mock("@/storage", async (original) => ({
	...(await original<typeof import("@/storage")>()),
	putLink: vi.fn(async () => {}),
	linkStatus: vi.fn(async () => null),
	revokeLink: vi.fn(async () => {}),
}));
vi.mock("@/links/snapshot", () => ({ takeSnapshot: vi.fn() }));
vi.mock("@/links/note-text", () => ({ noteText: vi.fn() }));

const relay = "https://relay.example";
const admin = { relayUrl: relay, secret: "secret" };
const snapshot: Snapshot = {
	html: "<p>Trip notes in <b>May</b></p>",
	takenAt: 1_760_000_000_000,
	left: { embeds: 0, images: 0, diagrams: 0 },
};
const options: ShareOptions = {
	expires: 2_000_000_000,
	maxViews: 5,
	passphrase: null,
	images: true,
	title: true,
};

function host() {
	const file = Object.assign(new TFile(), {
		path: "notes/Trip.md",
		basename: "Trip",
		extension: "md",
	});
	const getFileByPath = vi.fn((): TFile | null => file);
	const saveSettings = vi.fn(async () => {});
	const plugin = {
		app: { vault: { getFileByPath } },
		settings: { relayUrl: relay, relaySecret: "secret", links: [] },
		saveSettings,
	} as unknown as PluginHost;
	Object.assign(plugin, {
		sharedLinks: new SharedLinks(() => plugin.settings, saveSettings),
	});
	return { plugin, file, getFileByPath, saveSettings };
}

function record(file: TFile): LinkRecord {
	const id = newLinkId();
	return {
		id,
		url: linkUrl(relay, id, newLinkKey()),
		path: file.path,
		title: file.basename,
		createdAt: 1_760_000_000_000,
		publishedAt: 1_760_000_000_000,
		expires: options.expires,
		maxViews: options.maxViews,
		salt: null,
		images: true,
	};
}

function locationOf(record: LinkRecord) {
	const url = new URL(record.url);
	const location = parseLinkLocation(url.pathname, url.hash);
	assert(location);
	return location;
}

function uploadCall() {
	const call = vi.mocked(putLink).mock.calls[0];
	assert(call);
	return call;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(takeSnapshot).mockResolvedValue(snapshot);
	vi.mocked(noteText).mockResolvedValue("# Trip\nTrip notes in May");
});

describe("publishLink", () => {
	it("uploads a sealed snapshot and appends the unprotected link", async () => {
		const { plugin, file, saveSettings } = host();
		const existing = record(file);
		plugin.settings.links = [existing];

		const published = await publishLink(plugin, file, options);
		const location = locationOf(published);
		const [, id, sealed, uploadedOptions, update] = uploadCall();

		expect(published.url).toBe(
			`${relay}/s/${published.id}#${toBase64Url(location.key)}`,
		);
		expect(location.id).toBe(published.id);
		expect(published).toMatchObject({
			path: file.path,
			title: file.basename,
			expires: options.expires,
			maxViews: options.maxViews,
			salt: null,
			images: true,
		});
		expect(putLink).toHaveBeenCalledTimes(1);
		expect(uploadCall()[0]).toEqual(admin);
		expect(id).toBe(published.id);
		expect(update).toBeFalsy();
		expect(uploadedOptions).toEqual({
			expires: options.expires,
			maxViews: options.maxViews,
			protection: null,
		});
		expect(plugin.settings.links).toEqual([existing, published]);
		expect(saveSettings).toHaveBeenCalledTimes(1);
		expect(noteText).toHaveBeenCalledWith(plugin.app, file);
		expect(takeSnapshot).toHaveBeenCalledWith(
			plugin.app,
			file,
			"# Trip\nTrip notes in May",
			{ images: true },
		);
		expect(linkStatus).not.toHaveBeenCalled();

		const keys = await deriveLinkKeys(location.key);
		expect(await openLinkPayload(id, sealed, keys.content)).toEqual({
			html: snapshot.html,
			title: file.basename,
			createdAt: expect.any(Number),
		});
	});

	it("protects the payload with the passphrase and stores its salt", async () => {
		const { plugin, file } = host();
		const passphrase = "correct horse";
		const published = await publishLink(plugin, file, {
			...options,
			passphrase,
		});
		const { key } = locationOf(published);
		const [, id, sealed, uploadedOptions] = uploadCall();
		assert(published.salt);
		const salt = fromBase64Url(published.salt);
		const right = await deriveLinkKeys(key, { passphrase, salt });

		expect(putLink).toHaveBeenCalledTimes(1);
		expect(uploadedOptions.protection).toEqual({
			gate: right.gate,
			salt: published.salt,
		});
		expect(right.gate).toMatch(LINK_GATE_PATTERN);
		expect(plugin.settings.links).toEqual([published]);
		expect(await openLinkPayload(id, sealed, right.content)).toMatchObject({
			html: snapshot.html,
			title: file.basename,
		});

		const unprotected = await deriveLinkKeys(key);
		await expect(
			openLinkPayload(id, sealed, unprotected.content),
		).rejects.toThrow("This link cannot be opened.");
		const wrong = await deriveLinkKeys(key, {
			passphrase: "wrong horse",
			salt,
		});
		await expect(openLinkPayload(id, sealed, wrong.content)).rejects.toThrow(
			"This link cannot be opened.",
		);
	});

	it("publishes an empty title when the title is disabled", async () => {
		const { plugin, file } = host();
		const published = await publishLink(plugin, file, {
			...options,
			title: false,
		});
		const [, id, sealed] = uploadCall();
		const { content } = await deriveLinkKeys(locationOf(published).key);

		expect(published.title).toBe("");
		expect(await openLinkPayload(id, sealed, content)).toMatchObject({
			title: "",
			html: snapshot.html,
		});
	});

	it("refuses a snapshot whose sealed bytes exceed the size cap", async () => {
		const { plugin, file, saveSettings } = host();
		vi.mocked(takeSnapshot).mockResolvedValueOnce({
			...snapshot,
			html: randomBytes(LINK_MAX_SEALED_BYTES + 1024 * 1024).toString("base64"),
		});

		await expect(publishLink(plugin, file, options)).rejects.toThrow(TOO_LARGE);

		expect(putLink).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([]);
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it("refuses a snapshot too large to open, however well it packs", async () => {
		const { plugin, file } = host();
		vi.mocked(takeSnapshot).mockResolvedValueOnce({
			...snapshot,
			html: "a".repeat(40 * 1024 * 1024),
		});

		await expect(publishLink(plugin, file, options)).rejects.toThrow(TOO_LARGE);

		expect(putLink).not.toHaveBeenCalled();
	});
});

describe("updateLink", () => {
	it("uploads with update=true and keeps the same id and URL key", async () => {
		const { plugin, file, getFileByPath } = host();
		const published = record(file);
		plugin.settings.links = [published];
		const url = published.url;
		const updated = { ...snapshot, html: "<p>Updated note</p>" };
		vi.mocked(takeSnapshot).mockResolvedValueOnce(updated);

		await updateLink(plugin, published, null);

		expect(getFileByPath).toHaveBeenCalledWith(published.path);
		expect(putLink).toHaveBeenCalledTimes(1);
		const [, id, sealed, uploadedOptions, update] = uploadCall();
		expect(uploadCall()[0]).toEqual(admin);
		expect(id).toBe(published.id);
		expect(update).toBe(true);
		expect(uploadedOptions.protection).toBeNull();
		expect(published.url).toBe(url);
		expect(plugin.settings.links).toEqual([
			{ ...published, publishedAt: expect.any(Number) },
		]);
		expect(plugin.settings.links[0]?.publishedAt).toBeGreaterThan(
			published.publishedAt,
		);
		const { content } = await deriveLinkKeys(locationOf(published).key);
		expect(await openLinkPayload(id, sealed, content)).toMatchObject({
			title: file.basename,
			html: updated.html,
		});
	});

	it("refuses an update when the note is missing", async () => {
		const { plugin, file, getFileByPath } = host();
		const published = record(file);
		plugin.settings.links = [published];
		getFileByPath.mockReturnValueOnce(null);

		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			`The note is no longer at "${published.path}".`,
		);

		expect(putLink).not.toHaveBeenCalled();
		expect(takeSnapshot).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([published]);
	});

	it("requires a passphrase to update a salted record", async () => {
		const { plugin, file } = host();
		const published = { ...record(file), salt: toBase64Url(newLinkSalt()) };
		plugin.settings.links = [published];

		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			"Enter the link's passphrase.",
		);

		expect(putLink).not.toHaveBeenCalled();
	});

	it("updates the note where it is now, not where the list showed it", async () => {
		const { plugin, file, getFileByPath } = host();
		const shown = record(file);
		plugin.settings.links = [{ ...shown, path: "moved/Trip.md" }];

		await updateLink(plugin, shown, null);

		expect(getFileByPath).toHaveBeenCalledExactlyOnceWith("moved/Trip.md");
	});

	it("refuses a link stopped meanwhile", async () => {
		const { plugin, file } = host();

		await expect(updateLink(plugin, record(file), null)).rejects.toThrow(
			"This link is no longer shared.",
		);

		expect(putLink).not.toHaveBeenCalled();
	});

	it("refuses a second update of a link while one uploads", async () => {
		const { plugin, file } = host();
		const published = record(file);
		plugin.settings.links = [published];
		let finish = () => {};
		vi.mocked(putLink).mockImplementationOnce(
			() => new Promise<void>((resolve) => (finish = resolve)),
		);

		const first = updateLink(plugin, published, null);
		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			"This link is already updating.",
		);
		await vi.waitFor(() => expect(putLink).toHaveBeenCalled());
		finish();
		await first;

		await updateLink(plugin, published, null);
		expect(putLink).toHaveBeenCalledTimes(2);
	});
});

describe("revokeLinkRecord", () => {
	it("revokes at the relay before removing and saving the record", async () => {
		const { plugin, file, saveSettings } = host();
		const published = record(file);
		const other = record(file);
		plugin.settings.links = [published, other];
		vi.mocked(revokeLink).mockImplementationOnce(async () => {
			expect(plugin.settings.links).toEqual([published, other]);
			expect(saveSettings).not.toHaveBeenCalled();
		});

		await revokeLinkRecord(plugin, published);

		expect(revokeLink).toHaveBeenCalledExactlyOnceWith(admin, published.id);
		expect(plugin.settings.links).toEqual([other]);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});

	it("keeps the record when revoking fails", async () => {
		const { plugin, file, saveSettings } = host();
		const published = record(file);
		plugin.settings.links = [published];
		const failure = new Error("Relay unavailable");
		vi.mocked(revokeLink).mockRejectedValueOnce(failure);

		await expect(revokeLinkRecord(plugin, published)).rejects.toBe(failure);

		expect(revokeLink).toHaveBeenCalledExactlyOnceWith(admin, published.id);
		expect(plugin.settings.links).toEqual([published]);
		expect(saveSettings).not.toHaveBeenCalled();
	});
});

describe("a relay that changes meanwhile", () => {
	it("publishes a given snapshot as it is, without rendering again", async () => {
		const { plugin, file } = host();
		const looked = { ...snapshot, html: "<p>What the owner saw</p>" };

		await publishLink(plugin, file, options, looked);

		expect(takeSnapshot).not.toHaveBeenCalled();
		const [, id, sealed] = uploadCall();
		const key = locationOf(plugin.settings.links[0] as LinkRecord).key;
		const { content } = await deriveLinkKeys(key);
		expect((await openLinkPayload(id, sealed, content)).html).toBe(
			"<p>What the owner saw</p>",
		);
		expect(plugin.settings.links[0]?.publishedAt).toBe(looked.takenAt);
	});

	it("stores the note's path as it is once the upload ends", async () => {
		const { plugin, file } = host();
		vi.mocked(putLink).mockImplementationOnce(async () => {
			file.path = "moved/Trip.md";
		});

		const published = await publishLink(plugin, file, options);

		expect(published.path).toBe("moved/Trip.md");
		expect(plugin.settings.links).toEqual([published]);
	});

	it("sends the upload to the relay its address names", async () => {
		const { plugin, file } = host();
		vi.mocked(takeSnapshot).mockImplementationOnce(async () => {
			plugin.settings.relayUrl = "https://other.example";
			return snapshot;
		});

		const published = await publishLink(plugin, file, options);

		expect(published.url.startsWith(`${relay}/s/`)).toBe(true);
		expect(uploadCall()[0]).toEqual(admin);
	});

	it("refuses to publish with no relay set", async () => {
		const { plugin, file } = host();
		plugin.settings.relaySecret = "";

		await expect(publishLink(plugin, file, options)).rejects.toThrow(
			"Set up the relay",
		);
		expect(putLink).not.toHaveBeenCalled();
	});

	it("does not revoke, update or ask about a link of another relay", async () => {
		const { plugin, file, saveSettings } = host();
		const published = record(file);
		plugin.settings.links = [published];
		plugin.settings.relayUrl = "https://other.example";

		await expect(revokeLinkRecord(plugin, published)).rejects.toThrow(
			"another relay",
		);
		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			"another relay",
		);
		await expect(linkStatusOf(plugin, published)).rejects.toThrow(
			"another relay",
		);

		expect(revokeLink).not.toHaveBeenCalled();
		expect(putLink).not.toHaveBeenCalled();
		expect(linkStatus).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([published]);
		expect(saveSettings).not.toHaveBeenCalled();
	});
});
