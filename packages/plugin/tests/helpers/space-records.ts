import type { SpaceRecord } from "@/spaces/record";
import { SpaceRecords } from "@/spaces/records";

export function record(
	id: string,
	root: string,
	rev = 1,
	author = "laptop",
): SpaceRecord {
	return {
		id,
		name: id,
		root,
		rev,
		author,
		key: "",
		access: { kind: "owner", location: LOCATION },
	};
}

/** Someone else's share this device joined. */
export function joined(
	id: string,
	root: string,
	rev = 1,
	author = "laptop",
): SpaceRecord {
	return { ...record(id, root, rev, author), access: PARTICIPANT };
}

const PARTICIPANT = {
	kind: "participant" as const,
	relayUrl: "u",
	token: "t",
	participantId: "p1",
	personName: "Me",
};

const LOCATION = {
	endpoint: "https://s3.example",
	region: "auto",
	bucket: "notes",
	prefix: "vault",
	forcePathStyle: true,
};

/** One device's records, persisted into its own settings object. */
export function device(spaces: SpaceRecord[] = []) {
	const settings = {
		spaces,
		pausedSpaces: [] as string[],
		pauseArrivingShares: false,
		localRoots: {} as Record<string, string>,
		spacesVault: null as string | null,
	};
	return { settings, records: new SpaceRecords(settings, async () => {}) };
}
