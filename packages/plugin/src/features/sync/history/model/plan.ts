import { changeEntries } from "../changes";
import type { Cover, HistoryView, WalkedRecord } from "./cover";
import { dueResolution, groupStart, RESOLUTIONS } from "./periods";
import { addActivity, thin } from "./records";
import type {
	Activity,
	HistoryObject,
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

export function planGc(input: PlanInput): GcPlan {
	const { view, cover } = input;
	const present = new Set([...view.pushes.keys(), ...view.objects.keys()]);
	const deletes = new Set(
		[...cover.consumed].filter((key) => present.has(key)),
	);
	for (const key of lostPushes(input)) deletes.add(key);
	for (const key of foreign(input)) deletes.add(key);
	for (const key of expired(input)) deletes.add(key);

	const builds: Build[] = [];
	for (const target of targets(input)) {
		const build = buildOf(input, target);
		if (build) builds.push(build);
	}
	return { builds, deletes: [...deletes] };
}

/** Versions the replaced records named that the new object no longer does: phase 1's sweep candidates. */
export function freedHashes(
	replaced: readonly StoredRecord[],
	kept: readonly StoredRecord[],
): Set<string> {
	const keptHashes = new Set(
		kept.flatMap((record) => changeEntries(record.changes).map((e) => e.hash)),
	);
	const freed = new Set<string>();
	for (const record of replaced) {
		for (const { hash } of changeEntries(record.changes)) {
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

function buildOf(input: PlanInput, target: Target): Build | null {
	const { res, group } = target;
	const rank = RESOLUTIONS.indexOf(res);
	const inputs = new Set(target.walked.map((walked) => walked.source));
	const sameGroup: HistoryObject[] = [];
	for (const [key, { object }] of input.view.objects) {
		if (input.cover.consumed.has(key) || object.vaultId !== input.vaultId) {
			continue;
		}
		const objectRank = RESOLUTIONS.indexOf(object.res);
		if (objectRank > rank || groupStart(res, object.group) !== group) continue;
		// Off the walk but inside the group: its records are on the chain already.
		inputs.add(key);
		if (object.res === res) sameGroup.push(object);
	}
	const [only] = inputs;
	const settled =
		inputs.size === 1 && only !== undefined && sameGroup.length === 1;
	if (settled) return null;

	const records = target.walked.map((walked) => walked.record);
	const consumed = new Set(inputs);
	for (const key of inputs) {
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

/** Two counts of one group are two views of the same pushes: the larger stands, never the sum. */
function countsOf(
	records: readonly StoredRecord[],
	earlier: readonly HistoryObject[],
): Activity {
	const activity: Activity = {};
	for (const record of records) addActivity(activity, record.activity);
	const largest = earlier.reduce<Activity | undefined>(
		(best, object) =>
			pushesIn(object.activity) > pushesIn(best) ? object.activity : best,
		undefined,
	);
	if (largest) addActivity(activity, largest);
	return activity;
}

function pushesIn(activity: Activity | undefined): number {
	return Object.values(activity ?? {}).reduce(
		(sum, [pushes]) => sum + pushes,
		0,
	);
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

/** Off the walk, behind a gap, and past the horizon: kept until retention lets them go, never counted. */
function expired(input: PlanInput): string[] {
	const walked = new Set(input.cover.chain.map((walked) => walked.source));
	const past = (at: number): boolean =>
		dueResolution(at, input.now, input.horizon) === "counts";
	const keys: string[] = [];
	for (const [key, { push, at }] of input.view.pushes) {
		if (walked.has(key) || push.vaultId !== input.vaultId) continue;
		if (!input.cover.consumed.has(key) && past(at)) keys.push(key);
	}
	for (const [key, { object }] of input.view.objects) {
		const newest = Math.max(...object.records.map((record) => record.at));
		if (walked.has(key) || object.vaultId !== input.vaultId) continue;
		if (object.records.length > 0 && past(newest)) keys.push(key);
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
