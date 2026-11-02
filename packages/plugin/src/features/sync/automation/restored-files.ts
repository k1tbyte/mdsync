import type { CompareResult } from "../engine";
import { insideOf, type Space, vaultPathOf } from "../remote/space";
import type { DiffResult, LocalStore } from "../types";

/** Per space id, per path inside its root (a moved root keeps them): each hash a restore left, null: removed. */
type Holds = Map<string, Map<string, (string | null)[]>>;

/**
 * Files a history restore wrote or removed, kept out of automatic pushes while they hold what it left: its
 * dialogs promise nothing is pushed until the person says so. Kept on the device, so a restart keeps the promise.
 */
export class RestoredFiles {
	private holds: Holds;

	constructor(private readonly store: LocalStore) {
		this.holds = parse(store.load());
	}

	/** Before the write: one cut short must neither reach a push nor end an earlier restore's hold. */
	hold(space: Space, left: ReadonlyMap<string, string | null>): void {
		if (left.size === 0) return;
		const kept = new Map(this.holds.get(space.id));
		for (const [path, hash] of left) {
			const inside = insideOf(space, path);
			kept.set(inside, [...new Set([...(kept.get(inside) ?? []), hash])]);
		}
		this.save(space, kept);
	}

	/** Local changes that still hold what a restore left. */
	waiting(space: Space, diff: DiffResult): Set<string> {
		const kept = this.holds.get(space.id);
		if (!kept) return new Set();
		return new Set(
			diff.localChanges
				.filter(({ path, localHash }) =>
					kept.get(insideOf(space, path))?.includes(localHash),
				)
				.map(({ path }) => path),
		);
	}

	/**
	 * After every compare: a change to another hash (an edit) or a scanned file with no change (pushed, pulled)
	 * ends a hold. Unseen is unknown (ignored, unreadable, another spelling) and keeps it.
	 */
	settle(space: Space, { snapshot, diff }: CompareResult): void {
		const kept = this.holds.get(space.id);
		if (!kept) return;
		const changed = new Map<string, string | null>(
			[...diff.localChanges, ...diff.conflicts].map(({ path, localHash }) => [
				insideOf(space, path),
				localHash,
			]),
		);
		const still = new Map<string, (string | null)[]>();
		for (const [inside, hashes] of kept) {
			const local = changed.get(inside);
			if (local === undefined) {
				if (!Object.hasOwn(snapshot.files, vaultPathOf(space, inside))) {
					still.set(inside, hashes);
				}
			} else if (hashes.includes(local)) {
				still.set(inside, hashes.length > 1 ? [local] : hashes);
			}
		}
		if ([...kept].some(([inside, hashes]) => still.get(inside) !== hashes)) {
			this.save(space, still);
		}
	}

	private save(space: Space, kept: Map<string, (string | null)[]>): void {
		this.holds = new Map(this.holds);
		if (kept.size > 0) this.holds.set(space.id, kept);
		else this.holds.delete(space.id);
		this.store.save(
			Object.fromEntries(
				[...this.holds].map(([id, paths]) => [id, Object.fromEntries(paths)]),
			),
		);
	}
}

function parse(value: unknown): Holds {
	const holds: Holds = new Map();
	if (typeof value !== "object" || value === null) return holds;
	for (const [space, paths] of Object.entries(value)) {
		if (typeof paths !== "object" || paths === null) continue;
		const valid = Object.entries(paths).filter(
			(entry): entry is [string, (string | null)[]] =>
				Array.isArray(entry[1]) &&
				entry[1].every((hash) => typeof hash === "string" || hash === null),
		);
		if (valid.length > 0) holds.set(space, new Map(valid));
	}
	return holds;
}
