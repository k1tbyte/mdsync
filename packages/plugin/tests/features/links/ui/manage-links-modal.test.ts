import type { LinkStatus } from "@mdsync/protocol";
import { linkRecord } from "@tests/helpers/shared-links";
import type {
	ButtonComponent,
	ExtraButtonComponent,
	Setting,
} from "@tests/stubs/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/app/host";
import { linkStatusOf } from "@/features/links/publish";
import { SharedLinks } from "@/features/links/shared-links";
import { updateSharedLinks } from "@/features/links/ui/link-actions";
import { ManageLinksModal } from "@/features/links/ui/manage-links-modal";

vi.mock("@/features/links/publish", async (original) => ({
	...(await original<typeof import("@/features/links/publish")>()),
	linkStatusOf: vi.fn(async () => null),
}));
vi.mock("@/features/links/ui/link-actions", () => ({
	updateSharedLinks: vi.fn(async () => {}),
}));
vi.mock("@/core/ui/modals/confirm-modal", () => ({
	openConfirmModal: vi.fn(),
}));
vi.mock("@/core/ui/controls/copyable", () => ({ copyText: vi.fn() }));
vi.mock("@/core/ui/notices", () => ({ notifyError: vi.fn() }));
vi.mock("@/core/ui/modal-frame", () => ({
	renderModalHead: vi.fn(),
	modalFooter: vi.fn(),
	modalHint: vi.fn(),
	modalCard: vi.fn(),
}));
vi.mock("obsidian", async (original) => {
	const actual = await original<typeof import("@tests/stubs/obsidian")>();
	return {
		...actual,
		Modal: class extends actual.Modal {
			constructor(app: unknown) {
				super(app);
				// A redraw empties the list: the rows drawn before it are gone.
				this.contentEl.empty = () => {
					rows.length = 0;
				};
			}
		},
		Setting: class extends actual.Setting {
			constructor(containerEl?: unknown) {
				super(containerEl);
				rows.push(this);
			}
		},
	};
});

const rows: Setting[] = [];
const RECORD = linkRecord();
const labelOf = (button: ButtonComponent | ExtraButtonComponent) =>
	"text" in button ? button.text : button.tooltip;
const labels = (row: Setting | undefined) => row?.buttons.map(labelOf);
const press = (row: Setting | undefined, label: string) =>
	row?.buttons.find((button) => labelOf(button) === label)?.click();
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
	const sharedLinks = new SharedLinks({
		settings: () => settings,
		save: async () => {},
		author: () => "laptop",
		announce: () => {},
	});
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
		expect(labels(rows[0])).toEqual(["Copy link", "Stop sharing"]);
	});
	it("draws a record with a damaged address and still offers its removal", () => {
		host(null, [{ ...RECORD, url: "not a URL" }, RECORD]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.desc).toContain("address is damaged");
		expect(labels(rows[0])).toEqual(["Remove from the list"]);
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
		await press(rows[0], "Update");
		expect(updateSharedLinks).toHaveBeenCalledExactlyOnceWith(plugin, [RECORD]);
		expect(linkStatusOf).toHaveBeenCalledExactlyOnceWith(plugin, RECORD);
	});

	it("turns a link that expires while open into a remove-only row", async () => {
		const now = 1_900_000_000_000;
		vi.useFakeTimers({ now, toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.mocked(linkStatusOf).mockResolvedValue(LIVE);
		host(1, [{ ...RECORD, expires: now / 1000 + 60 }]);
		const actions = () => labels(rows[0]);
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
		await press(rows[0], "Update");
		expect(updateSharedLinks).toHaveBeenCalledWith(plugin, [
			{
				...RECORD,
				rev: 1,
				author: "laptop",
				path: "moved.md",
			},
		]);
	});

	it("removes an ended link through SharedLinks", async () => {
		const { sharedLinks } = host(1);
		await vi.waitFor(() => expect(rows[0]?.desc).toContain("Ended:"));
		await press(rows[0], "Remove from the list");
		expect(sharedLinks.all()).toEqual([]);
	});
});
