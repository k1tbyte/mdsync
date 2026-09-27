import { vi } from "vitest";
import type { SyncControllerHost } from "@/sync/controller";
import { mergeSessionIntoLocal, projectSession } from "@/sync/session-state";
import { VAULT_SPACE } from "@/sync/space";
import type { LocalState } from "@/sync/types";
import type { TestSession } from "./session";

export function createTestControllerHost(session: TestSession) {
	const identity = session.storage.identity();
	let local = mergeSessionIntoLocal(
		{ deviceId: session.state.deviceId, storages: {}, hashCache: {} },
		session.state,
		identity,
		VAULT_SPACE,
	);
	const host = {
		spaces: async () => [VAULT_SPACE],
		openSession: vi.fn<SyncControllerHost["openSession"]>(async () => ({
			...session.deps(),
			state: projectSession(local, identity, ""),
		})),
		persistState: async (state: LocalState) => {
			local = state;
		},
		getState: () => local,
		logInfo: vi
			.fn<SyncControllerHost["logInfo"]>()
			.mockResolvedValue(undefined),
		logWarn: vi
			.fn<SyncControllerHost["logWarn"]>()
			.mockResolvedValue(undefined),
		logError: vi
			.fn<SyncControllerHost["logError"]>()
			.mockResolvedValue(undefined),
		onPushComplete: vi.fn(),
	} satisfies SyncControllerHost;
	return host;
}
