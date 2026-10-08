import type { LinkStatus } from "@mdsync/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type LinkRecord, linkStatusOf, SharedLinks } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { updateSharedLinks } from "@/ui/links/link-actions";
import { ManageLinksModal } from "@/ui/links/manage-links-modal";

vi.mock("@/links", async (original) => ({
	...(await original<typeof import("@/links")>()),
	linkStatusOf: vi.fn(async () => null),
}));
vi.mock("@/ui/links/link-actions", () => ({
	updateSharedLinks: vi.fn(async () => {}),
}));
vi.mock("@/ui/modals", () => ({ openConfirmModal: vi.fn() }));
vi.mock("@/ui/common", async () => ({
	serial: (await import("@/ui/common/serial")).serial,
	copyText: vi.fn(),
	notifyError: vi.fn(),
}));
vi.mock("obsidian", () => ({
	Modal: class {
		modalEl = { addClass: () => {} };
		titleEl = { setText: () => {} };
		contentEl = {
			empty: () => {
				rows.length = 0;
			},
			createEl: () => {},
		};
		constructor(readonly app: object) {}
	},
	Setting: class {
		name = "";
		desc = "";
		descEl = { createDiv: () => {} };
		buttons: Button[] = [];
		constructor() {
			rows.push(this);
		}
		setName(name: string) {
			this.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.desc = desc;
			return this;
		}
		addButton(build: (button: Button) => void) {
			const button = new Button();
			build(button);
			this.buttons.push(button);
			return this;
		}
		addExtraButton(build: (button: Button) => void) {
			return this.addButton(build);
		}
	},
}));

class Button {
	text = "";
	click: () => Promise<void> = async () => {};
	setButtonText(text: string) {
		this.text = text;
		return this;
	}
	setTooltip(text: string) {
		this.text = text;
		return this;
	}
	setIcon() {
		return this;
	}
	setDisabled() {
		return this;
	}
	onClick(click: () => Promise<void>) {
		this.click = click;
		return this;
	}
}

const rows: { name: string; desc: string; buttons: Button[] }[] = [];
const RECORD: LinkRecord = {
	id: "one",
	url: "https://relay.example/one",
	path: "note.md",
	showTitle: true,
	detached: false,
	createdAt: 1,
	publishedAt: 1,
	expires: null,
	maxViews: null,
	salt: null,
	images: false,
};
const LIVE: LinkStatus = {
	views: 0,
	maxViews: null,
	expires: null,
	protected: false,
	size: 1,
};

function host(
	mtime: number | null,
	records = [RECORD],
	path: string | null = RECORD.path,
) {
	const settings = {
		links: records,
		relayUrl: "https://relay.example",
		relaySecret: "secret",
	};
	const sharedLinks = new SharedLinks(
		() => settings,
		async () => {},
	);
	const note = mtime === null ? null : { path: RECORD.path, stat: { mtime } };
	const plugin = {
		settings,
		sharedLinks,
		app: {
			vault: { getFileByPath: () => note, on: () => ({}), offref: () => {} },
		},
	} as unknown as PluginHost;
	new ManageLinksModal(plugin, path ?? undefined).onOpen();
	return { plugin, sharedLinks, note };
}

beforeEach(() => {
	rows.length = 0;
	vi.clearAllMocks();
	vi.mocked(linkStatusOf).mockResolvedValue(null);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ManageLinksModal", () => {
	it("names a detached row and hides Update while retaining Copy and Stop", async () => {
		vi.mocked(linkStatusOf).mockResolvedValue(LIVE);
		host(2, [{ ...RECORD, detached: true }], null);
		await vi.waitFor(() => expect(rows[0]?.desc).toContain("never expires"));
		expect(rows[0]?.name).toBe("note");
		expect(rows[0]?.desc).toBe("The note was deleted. 0 views · never expires");
		expect(rows[0]?.buttons.map(({ text }) => text)).toEqual([
			"Copy link",
			"Stop sharing",
		]);
	});
	it("draws a record with a damaged address and still offers its removal", () => {
		host(null, [{ ...RECORD, url: "not a URL" }, RECORD]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.desc).toContain("address is damaged");
		expect(rows[0]?.buttons.map(({ text }) => text)).toEqual([
			"Remove from the list",
		]);
	});

	it("starts changed notes with the stale line and keeps the status copy", async () => {
		host(2, [RECORD, { ...RECORD, id: "other", path: "other.md" }]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.desc).toBe("Changed since it was shared. Checking…");
		await vi.waitFor(() => expect(rows[0]?.desc).toContain("Ended:"));
		expect(rows[0]?.desc).toMatch(/^Changed since it was shared\./);
	});

	it("does not mark unchanged or missing notes as stale", () => {
		host(1);
		expect(rows[0]?.desc).toBe("Checking…");
		host(null);
		expect(rows[0]?.desc).toBe("Checking…");
	});

	it("uses the shared update flow and reloads only that record's status", async () => {
		vi.mocked(linkStatusOf).mockResolvedValue(LIVE);
		const other = { ...RECORD, id: "other" };
		const { plugin } = host(2, [RECORD, other]);
		await vi.waitFor(() =>
			expect(rows.every(({ desc }) => desc.includes("never expires"))).toBe(
				true,
			),
		);
		expect(linkStatusOf).toHaveBeenCalledTimes(2);
		vi.mocked(linkStatusOf).mockClear();
		vi.mocked(updateSharedLinks).mockImplementationOnce(async () => {
			expect(linkStatusOf).not.toHaveBeenCalled();
		});
		await rows[0]?.buttons.find(({ text }) => text === "Update")?.click();
		expect(updateSharedLinks).toHaveBeenCalledExactlyOnceWith(plugin, [RECORD]);
		expect(linkStatusOf).toHaveBeenCalledExactlyOnceWith(plugin, RECORD);
	});

	it("turns a link that expires while open into a remove-only row", async () => {
		const now = 1_900_000_000_000;
		vi.useFakeTimers({ now, toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.mocked(linkStatusOf).mockResolvedValue(LIVE);
		host(1, [{ ...RECORD, expires: now / 1000 + 60 }]);
		const actions = () => rows[0]?.buttons.map(({ text }) => text);
		await vi.waitFor(() => expect(actions()).toContain("Update"));

		vi.advanceTimersByTime(60_000);

		expect(actions()).toEqual(["Remove from the list"]);
		expect(rows[0]?.desc).toContain("Ended:");
		expect(linkStatusOf).toHaveBeenCalledTimes(1);
	});

	it("follows a rename while open and updates the moved link", async () => {
		vi.mocked(linkStatusOf).mockResolvedValue(LIVE);
		const { plugin, sharedLinks, note } = host(1);
		if (note) note.path = "moved.md";
		await sharedLinks.move(RECORD.path, "moved.md");
		expect(rows).toHaveLength(1);
		await rows[0]?.buttons.find(({ text }) => text === "Update")?.click();
		expect(updateSharedLinks).toHaveBeenCalledWith(plugin, [
			{
				...RECORD,
				path: "moved.md",
			},
		]);
	});

	it("removes an ended link through SharedLinks", async () => {
		const { sharedLinks } = host(1);
		await vi.waitFor(() => expect(rows[0]?.desc).toContain("Ended:"));
		await rows[0]?.buttons
			.find(({ text }) => text === "Remove from the list")
			?.click();
		expect(sharedLinks.all()).toEqual([]);
	});
});
