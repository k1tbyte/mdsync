import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { Invite } from "@/spaces/invite";
import type { SpaceRecord } from "@/spaces/record";
import { notifyInfo } from "@/ui/common/notices";
import { mountShare } from "@/ui/shares/invite-action";

vi.mock("@/ui/actions/push-action", () => ({ scopedPaths: () => [] }));
vi.mock("@/ui/modals", () => ({
	AcceptInviteModal: class {},
	openConfirmModal: vi.fn(),
}));
vi.mock("@/ui/common/notices", () => ({
	notifyInfo: vi.fn(),
	notifyError: vi.fn(),
	runWithNotice: vi.fn(),
}));

const INVITE: Invite = {
	id: "s1",
	name: "Team",
	key: "k",
	relayUrl: "https://relay.example",
	token: "t",
	participantId: "p",
	personName: "Me",
	readOnly: false,
};

function host(realtimeSync: boolean) {
	const added: SpaceRecord[] = [];
	const plugin = {
		app: {
			vault: {
				getAbstractFileByPath: () => null,
				createFolder: vi.fn(async () => {}),
			},
		},
		settings: { realtimeSync },
		spaces: {
			list: () => [],
			partition: () => [],
			add: async (record: SpaceRecord) => void added.push(record),
		},
		controller: {
			currentDevice: () => ({ id: "laptop" }),
			forgetSpace: vi.fn(async () => {}),
			refresh: vi.fn(async () => {}),
			getSnapshot: () => ({}),
		},
	} as unknown as PluginHost;
	return { plugin, added };
}

describe("mountShare", () => {
	beforeEach(() => vi.clearAllMocks());

	it("adds the share, and names the setting when real-time sync is off", async () => {
		const { plugin, added } = host(false);

		expect(await mountShare(plugin, INVITE, "Shared/Team")).toBeNull();

		expect(added).toHaveLength(1);
		expect(notifyInfo).toHaveBeenCalledWith(
			expect.stringContaining("Real-time sync"),
		);
	});

	it("says nothing about it once real-time sync is on", async () => {
		await mountShare(host(true).plugin, INVITE, "Shared/Team");

		expect(notifyInfo).toHaveBeenCalledOnce();
		expect(notifyInfo).not.toHaveBeenCalledWith(
			expect.stringContaining("Real-time sync"),
		);
	});
});
