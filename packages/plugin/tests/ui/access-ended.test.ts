import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceRecord } from "@/spaces/record";
import { openConfirmModal } from "@/ui/modals";
import { createAccessEnded } from "@/ui/shares/access-ended";

vi.mock("@/ui/modals", () => ({
	openConfirmModal: vi.fn(async () => false),
}));
vi.mock("@/ui/common/notices", () => ({
	notifyInfo: vi.fn(),
	notifyError: vi.fn(),
}));

const SHARE = { id: "s1", root: "Team" };
const RECHECK_MS = 90_000;

function participant(token = "t", closed = false): SpaceRecord {
	return {
		...SHARE,
		name: "Team",
		rev: 1,
		author: "laptop",
		key: "",
		access: {
			kind: "participant",
			relayUrl: "https://relay.example",
			token,
			participantId: "p1",
			personName: "Alex",
		},
		...(closed ? { closed: true as const } : {}),
	};
}

function host(initial: SpaceRecord) {
	let record = initial;
	const folder = { path: "Team" };
	const plugin = {
		app: {
			vault: {
				getFolderByPath: (path: string) => (path === "Team" ? folder : null),
			},
			fileManager: { trashFile: vi.fn(async () => {}) },
		},
		register: vi.fn(),
		spaces: {
			get: (id: string) => (id === record.id ? record : undefined),
			close: vi.fn(async () => {}),
		},
		controller: {
			currentDevice: () => ({ id: "laptop" }),
			refresh: vi.fn(async () => {}),
			forgetSpace: vi.fn(async () => {}),
		},
	};
	const ended = createAccessEnded(
		plugin as unknown as Parameters<typeof createAccessEnded>[0],
	);
	return {
		plugin,
		folder,
		ended,
		renew: (next: SpaceRecord) => {
			record = next;
		},
	};
}

describe("a participant whose link the broker refuses", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it("asks again past the KV lag before ending access", async () => {
		const { plugin, ended } = host(participant());

		ended(SHARE);
		expect(plugin.spaces.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(RECHECK_MS);
		expect(plugin.controller.refresh).toHaveBeenCalledOnce();

		ended(SHARE);
		ended(SHARE);
		await vi.runAllTimersAsync();

		expect(plugin.spaces.close).toHaveBeenCalledExactlyOnceWith("s1", "laptop");
		expect(plugin.controller.forgetSpace).toHaveBeenCalledWith(SHARE, {
			deleteRemote: false,
		});
		expect(openConfirmModal).toHaveBeenCalledOnce();
		expect(plugin.app.fileManager.trashFile).not.toHaveBeenCalled();
	});

	it("gives a new link its own wait", async () => {
		const { plugin, ended, renew } = host(participant("old"));
		ended(SHARE);
		await vi.advanceTimersByTimeAsync(RECHECK_MS);

		renew(participant("new"));
		ended(SHARE);
		await vi.advanceTimersByTimeAsync(RECHECK_MS - 1);

		expect(plugin.spaces.close).not.toHaveBeenCalled();
	});

	it("moves the folder to the trash when the person drops it", async () => {
		vi.mocked(openConfirmModal).mockResolvedValueOnce(true);
		const { plugin, folder, ended } = host(participant());
		ended(SHARE);
		await vi.advanceTimersByTimeAsync(RECHECK_MS);

		ended(SHARE);
		await vi.runAllTimersAsync();

		expect(plugin.app.fileManager.trashFile).toHaveBeenCalledWith(folder);
	});

	it("leaves a share already closed alone", async () => {
		const { plugin, ended } = host(participant("t", true));

		ended(SHARE);
		await vi.runAllTimersAsync();

		expect(plugin.controller.refresh).not.toHaveBeenCalled();
		expect(openConfirmModal).not.toHaveBeenCalled();
	});
});
