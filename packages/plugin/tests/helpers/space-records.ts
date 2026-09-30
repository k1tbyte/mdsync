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
