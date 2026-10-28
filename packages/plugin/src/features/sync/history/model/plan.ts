import { changeEntries } from "../changes";
import { mergeActivity, mergeCounts } from "./activity";
import type { Cover, HistoryView, WalkedRecord } from "./cover";
import { dueResolution, groupStart, RESOLUTIONS } from "./periods";
import { thin } from "./records";
import type {
	Activity,
	HistoryObject,
	PushRecord,
	Resolution,
	StoredRecord,
} from "./types";

/** A group counts as complete only once the walk reaches this far before it: storage clocks straggle a little. */
const COMPLETE_MARGIN_MS = 10 * 60_000;

export interface PlanInput {
	view: HistoryView;
	cover: Cover;
	vaultId: string;
	/** Storage time: the newest write in the listing. */
	now: number;
	/** ms, null to keep forever. */
	horizon: number | null;
	/** Storage time before which nothing can belong to a push still in flight. */
	settledBefore: number;
}

/** The store drops the key it writes a build under from `consumed`: an object never replaces itself. */
export type Build = Omit<HistoryObject, "v">;

export interface GcPlan {
	/** Each written, read back and checked before its `consumed` go. */
	builds: Build[];
	/** Safe to delete now: replaced by a present object, a lost push, another vault's. */
	deletes: string[];
}

interface Target {
	res: Resolution;
	group: number;
	walked: WalkedRecord[];
}

interface GroupedObject {
	key: string;
	object: HistoryObject;
}

export function planGc(input: PlanInput): GcPlan {
	const { view, cover } = input;
	const present = new Set([...view.pushes.keys(), ...view.objects.keys()]);
	const deletes = new Set(
		[...cover.consumed].filter((key) => present.has(key)),
	);
	for (const key of lostPushes(input)) deletes.add(key);
	for (const key of foreign(input)) deletes.add(key);
	for (const key of expired(input)) deletes.add(key);

	const whole = wholeKeys(input);
	const grouped = objectsByGroup(input);
	const builds: Build[] = [];
	for (const target of targets(input)) {
		const build = buildOf(input, target, whole, grouped);
		if (build) builds.push(build);
	}
	return { builds, deletes: [...deletes] };
}

/** Keys every record of which is on the walk. */
function wholeKeys(input: PlanInput): (key: string) => boolean {
	const taken = new Map<string, number>();
	for (const { source } of input.cover.chain) {
		taken.set(source, (taken.get(source) ?? 0) + 1);
	}
	return (key) =>
		(taken.get(key) ?? 0) ===
		(input.view.objects.get(key)?.object.records.length ?? 1);
}

/** Versions the replaced records named that the new object no longer does: phase 1's sweep candidates. */
export function freedHashes(
	replaced: readonly (Pick<StoredRecord, "changes"> &
		Pick<PushRecord, "released">)[],
	kept: readonly Pick<StoredRecord, "changes">[],
): Set<string> {
	const keptHashes = new Set(
		kept.flatMap((record) => changeEntries(record.changes).map((e) => e.hash)),
	);
	const freed = new Set<string>();
	for (const record of replaced) {
		const named = changeEntries(record.changes).map(({ hash }) => hash);
		for (const hash of [...named, ...(record.released ?? [])]) {
			if (!keptHashes.has(hash)) freed.add(hash);
		}
	}
	return freed;
}

function targets(input: PlanInput): Target[] {
	const byGroup = new Map<string, Target>();
	// Oldest first, so each group's records come in chain order.
	for (const walked of [...input.cover.chain].reverse()) {
		const due = dueResolution(walked.record.at, input.now, input.horizon);
		if (!due) continue;
		// Never finer than the object it sits in: that object's records would spill out of the group.
		const packed = input.view.objects.get(walked.source)?.object.res;
		const res =
			packed && RESOLUTIONS.indexOf(packed) > RESOLUTIONS.indexOf(due)
				? packed
				: due;
		const group = groupStart(res, walked.record.at);
		const id = `${res} ${group}`;
		const target = byGroup.get(id) ?? { res, group, walked: [] };
		target.walked.push(walked);
		byGroup.set(id, target);
	}
	const reach = oldestReached(input.cover);
	// Counts keep no versions, so a group past the horizon goes whole or not.
	return [...byGroup.values()].filter(
		(target) =>
			target.res === "counts" || target.group - COMPLETE_MARGIN_MS > reach,
	);
}

/** Storage time the walk reaches back to; anything newer is fully on it. */
function oldestReached(cover: Cover): number {
	if (!cover.truncated) return Number.NEGATIVE_INFINITY;
	const oldest = cover.chain.at(-1)?.record;
	return oldest ? oldest.firstAt : Number.POSITIVE_INFINITY;
}

/** Live objects of this vault by the group they fall in at each resolution at or coarser than their own. */
function objectsByGroup(input: PlanInput): Map<string, GroupedObject[]> {
	const grouped = new Map<string, GroupedObject[]>();
	for (const [key, { object }] of input.view.objects) {
		if (input.cover.consumed.has(key) || object.vaultId !== input.vaultId) {
			continue;
		}
		for (const res of RESOLUTIONS.slice(RESOLUTIONS.indexOf(object.res))) {
			const id = `${res} ${groupStart(res, object.group)}`;
			const bucket = grouped.get(id) ?? [];
			bucket.push({ key, object });
			grouped.set(id, bucket);
		}
	}
	return grouped;
}

function buildOf(
	input: PlanInput,
	target: Target,
	whole: (key: string) => boolean,
	grouped: ReadonlyMap<string, readonly GroupedObject[]>,
): Build | null {
	const { res, group } = target;
	const walked = new Set(target.walked.map(({ source }) => source));
	const inputs = new Set(walked);
	const sameGroup: HistoryObject[] = [];
	for (const { key, object } of grouped.get(`${res} ${group}`) ?? []) {
		inputs.add(key);
		if (object.res === res) sameGroup.push(object);
	}
	// Within the horizon what the walk did not take whole may hold a sibling or lie behind a gap: it stays.
	const replaced = res === "counts" ? [...inputs] : [...inputs].filter(whole);
	const [only] = walked;
	const built =
		walked.size === 1 &&
		only !== undefined &&
		input.view.objects.get(only)?.object.res === res;
	if (built && replaced.every((key) => key === only)) return null;

	const records = target.walked.map((walked) => walked.record);
	const consumed = new Set(replaced);
	for (const key of replaced) {
		for (const named of input.view.objects.get(key)?.object.consumed ?? []) {
			if (input.view.pushes.has(named) || input.view.objects.has(named)) {
				consumed.add(named);
			}
		}
	}
	const build: Build = {
		vaultId: input.vaultId,
		res,
		group,
		records: res === "counts" ? [] : thin(records, res),
		consumed: [...consumed].sort(),
	};
	if (res === "counts") {
		build.activity = countsOf(records, sameGroup);
		const newest = target.walked.at(-1)?.record.id;
		if (newest !== undefined) build.lastId = newest;
	}
	return build;
}

function countsOf(
	records: readonly StoredRecord[],
	earlier: readonly HistoryObject[],
): Activity {
	const activity: Activity = {};
	for (const record of records) mergeActivity(activity, record.activity);
	for (const object of earlier) mergeCounts(activity, object.activity ?? {});
	return activity;
}

/**
 * A push whose parent's next record on the chain is another push lost the publication guard and can never
 * join; a parent merged out of sight proves nothing, so that push stays.
 */
function lostPushes(input: PlanInput): string[] {
	const childOf = new Map<string, string>();
	const onChain = new Set<string>();
	for (const { record } of input.cover.chain) {
		onChain.add(record.id);
		if (record.parentId !== null) childOf.set(record.parentId, record.id);
	}
	const lost: string[] = [];
	for (const [key, { push, at }] of input.view.pushes) {
		if (input.cover.consumed.has(key) || onChain.has(push.id)) continue;
		if (push.vaultId !== input.vaultId || at >= input.settledBefore) continue;
		if (push.parentId === null || !onChain.has(push.parentId)) continue;
		const child = childOf.get(push.parentId);
		if (child !== undefined && child !== push.id) lost.push(key);
	}
	return lost;
}

/** Off the walk, behind a gap, past the horizon and settled: retention lets them go, never counted. */
function expired(input: PlanInput): string[] {
	const walked = new Set(input.cover.chain.map(({ source }) => source));
	const gone = (key: string, at: number, newest: number): boolean =>
		!walked.has(key) &&
		at < input.settledBefore &&
		dueResolution(newest, input.now, input.horizon) === "counts";
	const keys: string[] = [];
	for (const [key, { push, at }] of input.view.pushes) {
		if (push.vaultId === input.vaultId && gone(key, at, at)) keys.push(key);
	}
	for (const [key, { object, at }] of input.view.objects) {
		if (object.vaultId !== input.vaultId || object.records.length === 0) {
			continue;
		}
		const newest = Math.max(...object.records.map((record) => record.at));
		if (gone(key, at, newest)) keys.push(key);
	}
	return keys;
}

/** Left by a reset: another vault id. */
function foreign(input: PlanInput): string[] {
	const keys: string[] = [];
	for (const [key, { push, at }] of input.view.pushes) {
		if (push.vaultId !== input.vaultId && at < input.settledBefore)
			keys.push(key);
	}
	for (const [key, { object, at }] of input.view.objects) {
		if (object.vaultId !== input.vaultId && at < input.settledBefore)
			keys.push(key);
	}
	return keys;
}
