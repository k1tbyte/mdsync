import type { LogService } from "@/core/logs";
import { ESyncLogOperation } from "@/core/logs";
import {
	isRelayConfigured,
	type MdsyncSettings,
	ownerStorage,
} from "@/core/settings";
import { errorMessage } from "@/core/shared";
import type { Space } from "@/features/sync";
import { listParticipants, registerShareStorage } from "./broker/share-broker";
import { brokerStorage } from "./owner";
import type { SpaceRecords } from "./records";

/** Another owner device may have sent older keys: resent this often, so working ones win back. */
const RESEND_MS = 60 * 60_000;

/**
 * Keeps the broker signing with the current S3 credentials so rotated keys reach participants; sent only once
 * the share compared fine, so dead credentials never overwrite good ones.
 */
export function createShareRegistration(host: {
	settings: MdsyncSettings;
	spaces: SpaceRecords;
	logs: Pick<LogService, "warn">;
}): (space: Space) => Promise<void> {
	const sent = new Map<string, { memo: string; at: number }>();
	const send = async (space: Space): Promise<void> => {
		const { settings } = host;
		const record = host.spaces.list().find((each) => each.id === space.id);
		const s3 = ownerStorage(settings);
		if (record?.access.kind !== "owner" || !s3) return;
		if (!isRelayConfigured(settings)) return;
		const admin = { relayUrl: settings.relayUrl, secret: settings.relaySecret };
		const storage = brokerStorage(record.access.location, s3);
		const memo = JSON.stringify([admin, storage]);
		const last = sent.get(space.id);
		if (last?.memo === memo && Date.now() - last.at < RESEND_MS) return;
		// Credentials go only where an invite sent them before.
		if ((await listParticipants(admin, space.id)).length > 0) {
			await registerShareStorage(admin, space.id, storage);
		}
		sent.set(space.id, { memo, at: Date.now() });
	};
	// Unmarked on failure, so the next refresh tries again; never rejects, so the queue goes on.
	const trySend = (space: Space): Promise<void> =>
		send(space).catch((err: unknown) => {
			void host.logs.warn(
				ESyncLogOperation.Session,
				`Could not update "${space.root}" on the relay: ${errorMessage(err)}`,
			);
		});
	// One at a time, each reading the settings as they are then: the last one sent is the newest.
	let queue = Promise.resolve();
	return (space) => {
		queue = queue.then(() => trySend(space));
		return queue;
	};
}
