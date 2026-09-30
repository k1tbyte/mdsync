import { FakeEl, FakeModal } from "@tests/helpers/fake-obsidian-dom";
import { host, joined, owned } from "@tests/helpers/share-window-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import type { SpaceRecord } from "@/spaces/record";
import {
	endShare,
	leaveShare,
	listParticipants,
	revokeParticipant,
} from "@/storage";
import { notifyInfo } from "@/ui/common/notices";
import { openConfirmModal } from "@/ui/modals";
import { openShareWindow } from "@/ui/shares/share-window";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);
vi.mock("@/ui/common/notices", () => ({
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
	runWithNotice: vi.fn(),
}));
vi.mock("@/ui/modals", () => ({ openConfirmModal: vi.fn(async () => true) }));
vi.mock("@/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/storage")>()),
	listParticipants: vi.fn(async () => [
		{ id: "a", label: "Alice", readOnly: false },
	]),
	revokeParticipant: vi.fn(async () => {}),
	endShare: vi.fn(async () => {}),
	leaveShare: vi.fn(async () => {}),
}));

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let opened: FakeModal[] = [];

async function show(
	plugin: PluginHost,
	record: SpaceRecord,
	onClosed?: () => void,
): Promise<FakeModal> {
	const before = opened.length;
	vi.spyOn(FakeModal.prototype, "open").mockImplementation(function (
		this: FakeModal,
	) {
		opened.push(this);
		this.onOpen();
	});
	openShareWindow(plugin, record, onClosed);
	await settle();
	const modal = opened[before];
	if (!modal) throw new Error("no share window");
	return modal;
}

const click = (modal: FakeModal, text: string, index = 0) =>
	modal.modalEl
		.find((el: FakeEl) => el.tag === "button" && el.text === text)
		[index]?.fire("click");

beforeEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.stubGlobal("createFragment", () => new FakeEl("fragment"));
	opened = [];
});

describe("openShareWindow", () => {
	it("warns an owner whose invites went through a relay this vault no longer uses", async () => {
		const modal = await show(host().plugin, owned("https://old.example"));

		expect(modal.contentEl.textContent).toContain(
			"People were invited through https://old.example, which this vault no longer uses",
		);
	});

	it("says nothing extra when the relay is the vault's or none went out", async () => {
		const same = await show(host().plugin, owned("https://relay.example/"));
		const none = await show(host().plugin, owned());

		for (const modal of [same, none]) {
			expect(
				modal.contentEl.find((el) => el.hasClass("obsync-share-warning")),
			).toEqual([]);
		}
	});

	it("offers an owner with a relay the people and the invite form", async () => {
		const modal = await show(host().plugin, owned());

		expect(listParticipants).toHaveBeenCalledWith(
			{ relayUrl: "https://relay.example", secret: "secret" },
			"s1",
		);
		expect(modal.contentEl.textContent).toContain("Alice");
		expect(modal.modalEl.textContent).toContain("Create invite");
	});

	it("offers an owner without a relay only what is here", async () => {
		const modal = await show(host(false).plugin, owned());

		expect(listParticipants).not.toHaveBeenCalled();
		expect(modal.modalEl.textContent).not.toContain("Create invite");
	});

	it("asks before revoking, and revokes only once confirmed", async () => {
		const modal = await show(host().plugin, owned());
		vi.mocked(openConfirmModal).mockResolvedValueOnce(false);

		click(modal, "Revoke");
		await settle();
		expect(revokeParticipant).not.toHaveBeenCalled();

		click(modal, "Revoke");
		await settle();
		expect(openConfirmModal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Revoke Alice?",
				confirmLabel: "Revoke",
				confirmClass: "mod-warning",
			}),
		);
		expect(revokeParticipant).toHaveBeenCalledWith(
			{ relayUrl: "https://relay.example", secret: "secret" },
			"s1",
			"a",
		);
	});

	it("stops sharing in order, then closes the window", async () => {
		const { plugin } = host();
		const calls: string[] = [];
		vi.mocked(openConfirmModal).mockImplementationOnce(async () => {
			calls.push("confirm");
			return true;
		});
		vi.mocked(endShare).mockImplementationOnce(async () => {
			calls.push("end at the relay");
		});
		vi.mocked(plugin.spaces.close).mockImplementationOnce(async () => {
			calls.push("close the record");
		});
		vi.mocked(notifyInfo).mockImplementationOnce(() => {
			calls.push("notice");
		});
		const modal = await show(plugin, owned(), () =>
			calls.push("window closed"),
		);

		click(modal, "Stop sharing");
		await settle();

		expect(calls).toEqual([
			"confirm",
			"end at the relay",
			"close the record",
			"notice",
			"window closed",
		]);
		expect(openConfirmModal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Stop sharing "Team"?',
				confirmClass: "mod-warning",
			}),
		);
		expect(endShare).toHaveBeenCalledWith(
			{ relayUrl: "https://relay.example", secret: "secret" },
			"s1",
		);
		expect(modal.contentEl.children).toEqual([]);
	});

	it("keeps the share and its window when stopping is declined", async () => {
		const { plugin } = host();
		const onClosed = vi.fn();
		vi.mocked(openConfirmModal).mockResolvedValueOnce(false);
		const modal = await show(plugin, owned(), onClosed);

		click(modal, "Stop sharing");
		await settle();

		expect(endShare).not.toHaveBeenCalled();
		expect(plugin.spaces.close).not.toHaveBeenCalled();
		expect(notifyInfo).not.toHaveBeenCalled();
		expect(onClosed).not.toHaveBeenCalled();
		expect(modal.contentEl.children).not.toEqual([]);
	});

	it("leaves a share through the participant's own token, not the owner's relay secret", async () => {
		const { plugin } = host();
		const onClosed = vi.fn();
		const record = joined();
		const modal = await show(plugin, record, onClosed);

		click(modal, "Leave");
		await settle();

		expect(leaveShare).toHaveBeenCalledWith(record.access);
		expect(endShare).not.toHaveBeenCalled();
		expect(plugin.spaces.close).toHaveBeenCalledWith("s1", "laptop");
		expect(onClosed).toHaveBeenCalledTimes(1);
	});

	it("lets a participant leave, with no invite form", async () => {
		const modal = await show(host().plugin, joined(true));

		expect(modal.contentEl.textContent).toContain("Shared with you, read-only");
		expect(modal.modalEl.textContent).toContain("Leave");
		expect(modal.modalEl.textContent).not.toContain("Create invite");
	});

	it("pauses through the space records and refreshes the sync", async () => {
		const { plugin } = host();
		const modal = await show(plugin, owned());

		click(modal, "Pause on this device");
		await settle();

		expect(plugin.spaces.setPaused).toHaveBeenCalledWith("s1", true);
		expect(plugin.controller.refresh).toHaveBeenCalledTimes(1);
	});

	it("says so when another shared folder already holds the folder", async () => {
		const { plugin } = host();
		vi.spyOn(plugin.spaces, "partition").mockReturnValue([]);
		const modal = await show(plugin, owned());

		expect(modal.contentEl.textContent).toContain(
			'Not syncing: another shared folder already holds "Team".',
		);
		expect(modal.modalEl.textContent).not.toContain("Pause on this device");
	});
});
