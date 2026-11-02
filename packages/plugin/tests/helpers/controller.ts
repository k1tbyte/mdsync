import { vi } from "vitest";
import type { SyncControllerHost } from "@/features/sync/controller";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import {
	mergeSessionIntoLocal,
	projectSession,
} from "@/features/sync/session-state";
import type { LocalState } from "@/features/sync/types";
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
