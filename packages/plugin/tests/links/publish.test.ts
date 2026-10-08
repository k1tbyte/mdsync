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
	previewLink,
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
import { createLink, linkStatus, replaceLink, revokeLink } from "@/storage";

vi.mock("@/storage", async (original) => ({
	...(await original<typeof import("@/storage")>()),
	createLink: vi.fn(async () => 2_000_000_000),
	replaceLink: vi.fn(async () => {}),
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
	images: true,
	complete: true,
	left: { embeds: 0, images: 0, diagrams: 0 },
};
const options: ShareOptions = {
	ttl: 3600,
	maxViews: 5,
	passphrase: null,
	showTitle: true,
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
		showTitle: true,
		detached: false,
		createdAt: 1_760_000_000_000,
		publishedAt: 1_760_000_000_000,
		expires: 2_000_000_000,
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
	const call = vi.mocked(createLink).mock.calls[0];
	assert(call);
	return call;
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(createLink).mockResolvedValue(2_000_000_000);
	vi.mocked(takeSnapshot).mockResolvedValue(snapshot);
	vi.mocked(noteText).mockResolvedValue("# Trip\nTrip notes in May");
});

describe("publishLink", () => {
	it("revokes and removes the link when saving its record fails", async () => {
		const { plugin, file, saveSettings } = host();
		const existing = record(file);
		plugin.settings.links = [existing];
		const failure = new Error("Save failed");
		saveSettings.mockRejectedValueOnce(failure);
		const remove = vi.spyOn(plugin.sharedLinks, "remove");
		vi.mocked(revokeLink).mockImplementationOnce(async () => {
			expect(remove).not.toHaveBeenCalled();
			expect(plugin.settings.links).toHaveLength(2);
		});
		await expect(publishLink(plugin, file, options, snapshot)).rejects.toBe(
			failure,
		);
		const id = uploadCall()[1];
		expect(revokeLink).toHaveBeenCalledExactlyOnceWith(admin, id);
		expect(remove).toHaveBeenCalledExactlyOnceWith(id);
		expect(plugin.settings.links).toEqual([existing]);
	});

	it("retains the record when saving and revoking both fail, rethrowing the save error", async () => {
		const { plugin, file, saveSettings } = host();
		const failure = new Error("Save failed");
		saveSettings.mockRejectedValueOnce(failure);
		const remove = vi.spyOn(plugin.sharedLinks, "remove");
		vi.mocked(revokeLink).mockRejectedValueOnce(new Error("Relay unavailable"));

		await expect(publishLink(plugin, file, options, snapshot)).rejects.toBe(
			failure,
		);

		const id = uploadCall()[1];
		expect(revokeLink).toHaveBeenCalledExactlyOnceWith(admin, id);
		expect(remove).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([expect.objectContaining({ id })]);
	});

	it.each(["deleted", "recreated"])(
		"detaches the record when its note is %s during upload",
		async (change) => {
			const { plugin, file, getFileByPath } = host();
			vi.mocked(createLink).mockImplementationOnce(async () => {
				getFileByPath.mockReturnValue(
					change === "deleted"
						? null
						: Object.assign(new TFile(), { path: file.path }),
				);
				return 2_000_000_000;
			});
			const published = await publishLink(plugin, file, options, snapshot);
			expect(published.detached).toBe(true);
			expect(plugin.settings.links).toEqual([published]);
		},
	);

	it("uploads a sealed snapshot and appends the unprotected link", async () => {
		const { plugin, file, saveSettings } = host();
		const existing = record(file);
		plugin.settings.links = [existing];

		const looked = await previewLink(plugin, file, true);
		const published = await publishLink(plugin, file, options, looked);
		const location = locationOf(published);
		const [, id, sealed, uploadedOptions] = uploadCall();

		expect(published.url).toBe(
			`${relay}/s/${published.id}#${toBase64Url(location.key)}`,
		);
		expect(location.id).toBe(published.id);
		expect(published).toMatchObject({
			path: file.path,
			showTitle: true,
			detached: false,
			expires: 2_000_000_000,
			publishedAt: looked.takenAt,
			maxViews: options.maxViews,
			salt: null,
			images: true,
		});
		expect(createLink).toHaveBeenCalledTimes(1);
		expect(uploadCall()[0]).toEqual(admin);
		expect(id).toBe(published.id);
		expect(uploadedOptions).toEqual({
			ttl: options.ttl,
			maxViews: options.maxViews,
			gate: (await deriveLinkKeys(location.key)).gate,
			salt: null,
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
			createdAt: looked.takenAt,
		});
	});

	it("protects the payload with the passphrase and stores its salt", async () => {
		const { plugin, file } = host();
		const passphrase = "correct horse";
		const published = await publishLink(
			plugin,
			file,
			{
				...options,
				passphrase,
			},
			snapshot,
		);
		const { key } = locationOf(published);
		const [, id, sealed, uploadedOptions] = uploadCall();
		assert(published.salt);
		const salt = fromBase64Url(published.salt);
		const right = await deriveLinkKeys(key, { passphrase, salt });

		expect(createLink).toHaveBeenCalledTimes(1);
		expect(uploadedOptions).toMatchObject({
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
		const published = await publishLink(
			plugin,
			file,
			{
				...options,
				showTitle: false,
			},
			snapshot,
		);
		const [, id, sealed] = uploadCall();
		const { content } = await deriveLinkKeys(locationOf(published).key);

		expect(published.showTitle).toBe(false);
		expect(await openLinkPayload(id, sealed, content)).toMatchObject({
			title: "",
			html: snapshot.html,
		});
	});

	it("refuses a snapshot whose sealed bytes exceed the size cap", async () => {
		const { plugin, file, saveSettings } = host();
		const large = {
			...snapshot,
			html: randomBytes(LINK_MAX_SEALED_BYTES + 1024 * 1024).toString("base64"),
		};

		await expect(publishLink(plugin, file, options, large)).rejects.toThrow(
			TOO_LARGE,
		);

		expect(createLink).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([]);
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it("refuses a snapshot too large to open, however well it packs", async () => {
		const { plugin, file } = host();
		const large = { ...snapshot, html: "a".repeat(40 * 1024 * 1024) };

		await expect(publishLink(plugin, file, options, large)).rejects.toThrow(
			TOO_LARGE,
		);

		expect(createLink).not.toHaveBeenCalled();
	});
});

describe("updateLink", () => {
	it.each([true, false])(
		"shares a snapshot across links with matching image flags: %s",
		async (sameImages) => {
			const { plugin, file } = host();
			const first = record(file);
			const second = { ...record(file), images: sameImages };
			plugin.settings.links = [first, second];
			const rendered = new Map<boolean, Promise<Snapshot>>();

			await Promise.all([
				updateLink(plugin, first, null, rendered),
				updateLink(plugin, second, null, rendered),
			]);

			expect(takeSnapshot).toHaveBeenCalledTimes(sameImages ? 1 : 2);
			expect(noteText).toHaveBeenCalledTimes(sameImages ? 1 : 2);
			expect(rendered.size).toBe(sameImages ? 1 : 2);
			expect(takeSnapshot).toHaveBeenCalledWith(
				plugin.app,
				file,
				expect.any(String),
				{ images: true },
			);
			if (!sameImages) {
				expect(takeSnapshot).toHaveBeenCalledWith(
					plugin.app,
					file,
					expect.any(String),
					{ images: false },
				);
			}
			expect(replaceLink).toHaveBeenCalledTimes(2);
		},
	);

	it("refuses an update of a detached note", async () => {
		const { plugin, file } = host();
		const published = { ...record(file), detached: true };
		plugin.settings.links = [published];
		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			"The note was deleted.",
		);
		expect(replaceLink).not.toHaveBeenCalled();
		expect(takeSnapshot).not.toHaveBeenCalled();
	});
	it("uploads with update=true and keeps the same id and URL key", async () => {
		const { plugin, file, getFileByPath } = host();
		const published = record(file);
		plugin.settings.links = [published];
		const url = published.url;
		const updated = { ...snapshot, html: "<p>Updated note</p>" };
		vi.mocked(takeSnapshot).mockResolvedValueOnce(updated);

		await updateLink(plugin, published, null);

		expect(getFileByPath).toHaveBeenCalledWith(published.path);
		expect(replaceLink).toHaveBeenCalledTimes(1);
		const call = vi.mocked(replaceLink).mock.calls[0];
		assert(call);
		const [uploadedAdmin, id, sealed, gate] = call;
		expect(uploadedAdmin).toEqual(admin);
		expect(id).toBe(published.id);
		expect(gate).toBe((await deriveLinkKeys(locationOf(published).key)).gate);
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

		expect(replaceLink).not.toHaveBeenCalled();
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

		expect(replaceLink).not.toHaveBeenCalled();
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

		expect(replaceLink).not.toHaveBeenCalled();
	});

	it("refuses a second update of a link while one uploads", async () => {
		const { plugin, file } = host();
		const published = record(file);
		plugin.settings.links = [published];
		let finish = () => {};
		vi.mocked(replaceLink).mockImplementationOnce(
			() => new Promise<void>((resolve) => (finish = resolve)),
		);

		const first = updateLink(plugin, published, null);
		await expect(updateLink(plugin, published, null)).rejects.toThrow(
			"This link is already updating.",
		);
		await vi.waitFor(() => expect(replaceLink).toHaveBeenCalled());
		finish();
		await first;

		await updateLink(plugin, published, null);
		expect(replaceLink).toHaveBeenCalledTimes(2);
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
		const looked = {
			...snapshot,
			html: "<p>What the owner saw</p>",
			images: false,
		};

		await publishLink(plugin, file, options, looked);

		expect(takeSnapshot).not.toHaveBeenCalled();
		const [, id, sealed] = uploadCall();
		const key = locationOf(plugin.settings.links[0] as LinkRecord).key;
		const { content } = await deriveLinkKeys(key);
		expect((await openLinkPayload(id, sealed, content)).html).toBe(
			"<p>What the owner saw</p>",
		);
		expect(plugin.settings.links[0]?.publishedAt).toBe(looked.takenAt);
		expect(plugin.settings.links[0]?.images).toBe(false);
		expect((await openLinkPayload(id, sealed, content)).createdAt).toBe(
			looked.takenAt,
		);
	});

	it("stores the note's path as it is once the upload ends", async () => {
		const { plugin, file } = host();
		vi.mocked(createLink).mockImplementationOnce(async () => {
			file.path = "moved/Trip.md";
			return 2_000_000_000;
		});

		const published = await publishLink(plugin, file, options, snapshot);

		expect(published.path).toBe("moved/Trip.md");
		expect(plugin.settings.links).toEqual([published]);
	});

	it("sends the upload to the relay its address names", async () => {
		const { plugin, file } = host();
		vi.mocked(createLink).mockImplementationOnce(async () => {
			plugin.settings.relayUrl = "https://other.example";
			return 2_000_000_000;
		});

		const published = await publishLink(plugin, file, options, snapshot);

		expect(published.url.startsWith(`${relay}/s/`)).toBe(true);
		expect(uploadCall()[0]).toEqual(admin);
	});

	it("refuses to publish with no relay set", async () => {
		const { plugin, file } = host();
		plugin.settings.relaySecret = "";

		await expect(publishLink(plugin, file, options, snapshot)).rejects.toThrow(
			"Set up the relay",
		);
		expect(createLink).not.toHaveBeenCalled();
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
		expect(replaceLink).not.toHaveBeenCalled();
		expect(linkStatus).not.toHaveBeenCalled();
		expect(plugin.settings.links).toEqual([published]);
		expect(saveSettings).not.toHaveBeenCalled();
	});
});
