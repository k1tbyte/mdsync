import type { ListedObject, ObjectStorage } from "./types";

/** Every key under `prefix`, with its etag and write time where the backend reports them. */
export async function listEntries(
	storage: ObjectStorage,
	prefix: string,
): Promise<ListedObject[]> {
	if (storage.listDetailed) return storage.listDetailed(prefix);
	return (await storage.list(prefix)).map((key) => ({
		key,
		etag: null,
		modified: null,
	}));
}
