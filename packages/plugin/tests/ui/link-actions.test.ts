import type { Command, Plugin } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerCommands } from "@/commands";
import { type LinkRecord, SharedLinks, updateLink } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { notifyError, notifyInfo } from "@/ui/common";
import { updateSharedLink } from "@/ui/links/link-actions";
import { openPromptModal } from "@/ui/modals";

vi.mock("@/links", async (original) => ({
	...(await original<typeof import("@/links")>()),
	updateLink: vi.fn(async () => {}),
}));
vi.mock("@/ui/common", () => ({ notifyInfo: vi.fn(), notifyError: vi.fn() }));
vi.mock("@/ui/modals", () => ({ openPromptModal: vi.fn() }));
vi.mock("@/ui", async () => ({
	...(await import("@/ui/common")),
	...(await import("@/ui/links/link-actions")),
	canRebuild: vi.fn(),
	deepCleanOrphanedObjects: vi.fn(),
	isLinkable: vi.fn(),
	openDiffView: vi.fn(),
	openInvite: vi.fn(),
	openManageLinks: vi.fn(),
	openShareLink: vi.fn(),
	openShareWindow: vi.fn(),
	openSourceControlDeleted: vi.fn(),
	openSourceControlHistory: vi.fn(),
	openSourceControlView: vi.fn(),
	openWhereMenu: vi.fn(),
	rebuildLiveNote: vi.fn(),
	resetRemoteStorage: vi.fn(),
	runWithNotice: vi.fn(),
	toggleAuthors: vi.fn(),
	verifyRemoteIntegrity: vi.fn(),
}));

const RECORD: LinkRecord = {
	id: "one",
	url: "https://relay.example/one",
	path: "note.md",
	title: "Note",
	createdAt: 1,
	publishedAt: 1,
	expires: null,
	maxViews: null,
	salt: null,
	images: false,
};

function host(records: LinkRecord[] = [RECORD]) {
	let file: { path: string } | null = { path: RECORD.path };
	const settings = {
		links: records,
		relayUrl: "https://relay.example",
		relaySecret: "secret",
	};
	const plugin = {
		settings,
		sharedLinks: new SharedLinks(
			() => settings,
			async () => {},
		),
		app: {
			workspace: { getActiveFile: () => file },
			vault: { getFileByPath: () => ({ stat: { mtime: 1 } }) },
		},
		addCommand: (command: Command) => commands.push(command),
	} as unknown as Plugin & PluginHost;
	const commands: Command[] = [];
	registerCommands(plugin, () => false);
	const command = commands.find(({ id }) => id === "update-note-links");
	if (!command?.checkCallback) throw new Error("Missing update command");
	return {
		plugin,
		check: command.checkCallback,
		setFile: (next: typeof file) => {
			file = next;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(updateLink).mockResolvedValue(undefined);
	vi.mocked(openPromptModal).mockResolvedValue("passphrase");
});

describe("updateSharedLink", () => {
	it("updates an unprotected link without asking and keeps the view-limit copy", async () => {
		const { plugin } = host();
		const record = { ...RECORD, maxViews: 5 };
		await updateSharedLink(plugin, record);
		expect(openPromptModal).not.toHaveBeenCalled();
		expect(updateLink).toHaveBeenCalledWith(plugin, record, null);
		expect(notifyInfo).toHaveBeenCalledWith(
			"The link now shows the note as it is. Views already used stay used.",
		);
	});

	it("asks for a protected link's passphrase and skips a cancelled prompt", async () => {
		const { plugin } = host();
		const record = { ...RECORD, salt: "salt" };
		await updateSharedLink(plugin, record);
		expect(openPromptModal).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Passphrase", confirmLabel: "Update" }),
		);
		expect(updateLink).toHaveBeenCalledWith(plugin, record, "passphrase");
		vi.mocked(updateLink).mockClear();
		vi.mocked(notifyInfo).mockClear();
		vi.mocked(openPromptModal).mockResolvedValueOnce(null);
		await updateSharedLink(plugin, record);
		expect(updateLink).not.toHaveBeenCalled();
		expect(notifyInfo).not.toHaveBeenCalled();
	});
});

describe("update-note-links command", () => {
	it("requires an active note with live links on this relay", () => {
		const { check, plugin, setFile } = host();
		expect(check(true)).toBe(true);
		expect(updateLink).not.toHaveBeenCalled();
		setFile(null);
		expect(check(true)).toBe(false);
		setFile({ path: "private.md" });
		expect(check(true)).toBe(false);
		setFile({ path: RECORD.path });
		plugin.settings.relayUrl = "https://other.example";
		expect(check(true)).toBe(false);
		expect(host([{ ...RECORD, expires: 1 }]).check(true)).toBe(false);
	});

	it("updates in turn, skipping other relays, expired links and cancelled prompts", async () => {
		const cancelled = { ...RECORD, id: "cancelled", salt: "salt" };
		const protectedLink = { ...RECORD, id: "protected", salt: "salt" };
		const { check } = host([
			cancelled,
			protectedLink,
			RECORD,
			{ ...RECORD, id: "expired", expires: 1 },
			{ ...RECORD, id: "other", url: "https://other.example/one" },
		]);
		vi.mocked(openPromptModal).mockResolvedValueOnce(null);
		const order: string[] = [];
		vi.mocked(updateLink).mockImplementation(async (_plugin, record) => {
			order.push(`start:${record.id}`);
			await Promise.resolve();
			order.push(`end:${record.id}`);
		});
		expect(check(false)).toBe(true);
		await vi.waitFor(() => expect(updateLink).toHaveBeenCalledTimes(2));
		expect(openPromptModal).toHaveBeenCalledTimes(2);
		expect(order).toEqual([
			"start:protected",
			"end:protected",
			"start:one",
			"end:one",
		]);
	});

	it("reports errors like the modal and continues to the next link", async () => {
		const error = new Error("offline");
		vi.mocked(updateLink).mockRejectedValueOnce(error);
		const { check } = host([RECORD, { ...RECORD, id: "two" }]);
		check(false);
		await vi.waitFor(() => expect(updateLink).toHaveBeenCalledTimes(2));
		expect(notifyError).toHaveBeenCalledWith(
			"Could not change the link",
			error,
		);
	});
});
