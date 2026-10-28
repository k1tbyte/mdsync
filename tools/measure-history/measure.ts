/**
 * Runs inside Obsidian (run.mjs) on a vault already set up and unlocked: reads its history through the plugin's
 * session, writes nothing itself and returns sizes only. Each changed version costs: as stored, sealed whole, or chunked (design 9.3).
 */

import { compressToBase64, decompressFromBase64 } from "lz-string";
import { type ChunkParams, chunkEnds, gearTable } from "@/core/chunking";
import {
	decryptBytes,
	decryptJson,
	type EncryptionKey,
	encryptCompressible,
	encryptJson,
	sha256Hex,
} from "@/core/crypto";
import { isDrawing } from "@/core/drawing";
import { runWithConcurrency } from "@/core/utils";
import type { ObjectStorage } from "@/features/storage";
import {
	REMOTE_HISTORY_LOG_KEY,
	REMOTE_OBJECTS_PREFIX,
} from "@/features/sync/constants";
import type { Activity } from "@/features/sync/history/model/types";
import { readHistory } from "@/features/sync/history/remote";
import type { SnapshotChanges } from "@/features/sync/history/types";

const KB = 1024;
const MB = 1024 * KB;
const SCHEMES = {
	A: { threshold: 256 * KB, params: sizes(16, 64, 256) },
	B: { threshold: 64 * KB, params: sizes(8, 32, 128) },
	C: { threshold: 256 * KB, params: sizes(32, 128, 512) },
};
type Scheme = (typeof SCHEMES)[keyof typeof SCHEMES];
/** Every scheme cuts 1 MB chunks past it, so a 100 MB file is ~100 objects, not ~1600. */
const LARGE = { above: 16 * MB, params: sizes(256, 1024, 4096) };
const BUCKETS: [number, string][] = [
	[16 * KB, "<16K"],
	[64 * KB, "16-64K"],
	[256 * KB, "64-256K"],
	[MB, "256K-1M"],
	[16 * MB, "1-16M"],
	[Number.POSITIVE_INFINITY, ">16M"],
];
const GEAR = gearTable(0x6d64);
const TEXT = /\.(md|canvas|json|txt|csv|tsv|xml|html|css|js|ts|ya?ml)$/i;
const COMPRESSED_SCENE =
	/(## Drawing[ \t]*\r?\n)```compressed-json\r?\n([\s\S]*?)\r?\n```/;

export interface Options {
	/** Newest pairs kept. */
	maxPairs?: number;
	/** A pair with a larger side is skipped. */
	maxBytes?: number;
}

export interface Group {
	kind: string;
	bucket: string;
	pairs: number;
	/** The newer version's blob as stored now. */
	today: number;
	/** Sealed whole by today's write path. */
	whole: number;
	/** New chunks sealed plus the recipe, chunked against the older version only. */
	schemes: Record<string, number>;
	/** Scheme A over the scene stored as plain JSON (LZString drawings). */
	decoded?: number;
}

export interface Report {
	layout: string;
	pushes: number;
	days: number;
	busiestDay: number;
	historyKeys: number;
	historyBytes: number | null;
	pairs: number;
	skipped: number;
	drawings: { compressed: number; reproducible: number };
	groups: Group[];
}

interface Pair {
	path: string;
	from: string;
	to: string;
}

interface Version {
	stored: number;
	plain: Uint8Array;
}

export async function run(options: Options = {}): Promise<Report> {
	// biome-ignore lint/suspicious/noExplicitAny: plugin internals, reached at run time in any version.
	const plugin = (window as any).app.plugins.plugins.mdsync;
	const session = await plugin?.controller?.history?.deps?.openSession();
	if (!session) throw new Error("MDSync is not set up or is locked here.");
	const storage: ObjectStorage = session.storage;
	const key: EncryptionKey = session.key;
	const source = await historyOf(storage, key);
	const pairs = source.pairs.slice(0, options.maxPairs ?? source.pairs.length);
	const limit = options.maxBytes ?? 64 * MB;
	const groups = new Map<string, Group>();
	const drawings = { compressed: 0, reproducible: 0 };
	let skipped = 0;
	let done = 0;
	await runWithConcurrency(chainsOf(pairs), 4, async (chain) => {
		// A chain runs newest first, so the next pair's newer side is this one's older side.
		let loaded = new Map<string, Promise<Version | null>>();
		for (const pair of chain) {
			const load = (hash: string) =>
				loaded.get(hash) ?? read(storage, key, hash);
			const [from, to] = [load(pair.from), load(pair.to)];
			loaded = new Map([
				[pair.from, from],
				[pair.to, to],
			]);
			const [older, newer] = await Promise.all([from, to]);
			if (
				!older ||
				!newer ||
				Math.max(older.plain.length, newer.plain.length) > limit
			) {
				skipped++;
				continue;
			}
			const text = TEXT.test(pair.path)
				? new TextDecoder().decode(newer.plain)
				: "";
			const kind = kindOf(pair.path, text);
			const group = groupOf(groups, kind, newer.plain.length);
			group.pairs++;
			group.today += newer.stored;
			// Awaited first: `+=` would read the shared total before the await and drop another path's add.
			const whole = (await encryptCompressible(key, newer.plain)).length;
			group.whole += whole;
			for (const [name, scheme] of Object.entries(SCHEMES)) {
				const cost = await versionCost(key, older.plain, newer.plain, scheme);
				group.schemes[name] = (group.schemes[name] ?? 0) + cost;
			}
			const after = kind === "drawing (LZString)" ? decoded(text) : null;
			if (after) {
				drawings.compressed++;
				if (after.reproducible) drawings.reproducible++;
				const before =
					decoded(new TextDecoder().decode(older.plain))?.bytes ?? older.plain;
				const cost = await versionCost(key, before, after.bytes, SCHEMES.A);
				group.decoded = (group.decoded ?? 0) + cost;
			}
			if (++done % 50 === 0) console.log(`measured ${done}/${pairs.length}`);
		}
	});
	const days = perDay(source.pushes);
	return {
		layout: source.layout,
		pushes: days.reduce((sum, count) => sum + count, 0),
		days: days.length,
		busiestDay: Math.max(0, ...days),
		historyKeys: source.keys,
		historyBytes: source.bytes,
		pairs: pairs.length,
		skipped,
		drawings,
		groups: [...groups.values()],
	};
}

interface Source {
	layout: string;
	/** Newest first. */
	pairs: Pair[];
	/** [time, pushes]: a packed period reports its pushes per hour. */
	pushes: [number, number][];
	keys: number;
	bytes: number | null;
}

/** The 1.x log while it is there, else the records under `history/` that nothing consumed. */
async function historyOf(
	storage: ObjectStorage,
	key: EncryptionKey,
): Promise<Source> {
	const log = await storage.get(REMOTE_HISTORY_LOG_KEY);
	if (log) {
		const { snapshots, changes } = await decryptJson<{
			snapshots: { id: string; createdAt: number }[];
			changes: Record<string, SnapshotChanges>;
		}>(key, log);
		const newest = [...snapshots].sort((a, b) => b.createdAt - a.createdAt);
		return {
			layout: "1.x log",
			pairs: newest.flatMap(({ id }) => pairsOf(changes[id])),
			pushes: snapshots.map(({ createdAt }) => [createdAt, 1]),
			keys: 1,
			bytes: log.length,
		};
	}
	const { view } = await readHistory(storage, key, "");
	const consumed = new Set(
		[...view.objects.values()].flatMap(({ object }) => object.consumed),
	);
	const live = <T>(map: ReadonlyMap<string, T>) =>
		[...map].filter(([at]) => !consumed.has(at)).map(([, value]) => value);
	const records = [
		...live(view.pushes).map(({ push }) => push),
		...live(view.objects).flatMap(({ object }) => object.records),
	].sort((a, b) => b.createdAt - a.createdAt);
	return {
		layout: "history/ (a packed period is one pair per path)",
		pairs: records.flatMap(({ changes }) => pairsOf(changes)),
		pushes: [
			...live(view.pushes).map(({ at }): [number, number] => [at, 1]),
			...live(view.objects).flatMap(({ object }) =>
				[
					object.activity ?? {},
					...object.records.map((r) => r.activity),
				].flatMap(hoursOf),
			),
		],
		keys: view.pushes.size + view.objects.size,
		bytes: null,
	};
}

function pairsOf(changes: SnapshotChanges | undefined): Pair[] {
	return Object.entries(changes?.modified ?? {})
		.filter(([, { from, to }]) => from.hash !== to.hash)
		.map(([path, { from, to }]) => ({ path, from: from.hash, to: to.hash }));
}

/** Pairs per path, newest first, each pair once. */
function chainsOf(pairs: readonly Pair[]): Pair[][] {
	const chains = new Map<string, Map<string, Pair>>();
	for (const pair of pairs) {
		const chain = chains.get(pair.path) ?? new Map<string, Pair>();
		chain.set(`${pair.from}>${pair.to}`, pair);
		chains.set(pair.path, chain);
	}
	return [...chains.values()].map((chain) => [...chain.values()]);
}

/** Null when the blob is gone or unreadable: the pair is skipped, not the run. */
async function read(
	storage: ObjectStorage,
	key: EncryptionKey,
	hash: string,
): Promise<Version | null> {
	try {
		const blob = await storage.get(`${REMOTE_OBJECTS_PREFIX}${hash}`);
		return (
			blob && { stored: blob.length, plain: await decryptBytes(key, blob) }
		);
	} catch {
		return null;
	}
}

/** Storing `to` once `from` is stored: its new chunks and a recipe, or the whole file under the threshold. */
async function versionCost(
	key: EncryptionKey,
	from: Uint8Array,
	to: Uint8Array,
	{ threshold, params }: Scheme,
): Promise<number> {
	if (to.length < threshold) return (await encryptCompressible(key, to)).length;
	const cut = (size: number) => (size > LARGE.above ? LARGE.params : params);
	// Below the threshold the older version was stored whole: no chunk of it exists to reuse.
	const stored =
		from.length < threshold ? [] : await chunksOf(from, cut(from.length));
	const known = new Set(stored.map(({ id }) => id));
	const recipe: [string, number][] = [];
	let cost = 0;
	for (const { id, bytes } of await chunksOf(to, cut(to.length))) {
		recipe.push([id, bytes.length]);
		if (known.has(id)) continue;
		known.add(id);
		cost += (await encryptCompressible(key, bytes)).length;
	}
	return cost + (await encryptJson(key, recipe)).length;
}

async function chunksOf(bytes: Uint8Array, params: ChunkParams) {
	const chunks: { id: string; bytes: Uint8Array }[] = [];
	let start = 0;
	for (const end of chunkEnds(bytes, params, GEAR)) {
		const part = bytes.subarray(start, end);
		chunks.push({ id: await sha256Hex(part), bytes: part });
		start = end;
	}
	return chunks;
}

/**
 * The drawing with its scene as plain JSON, the form a codec would store. `reproducible`: compressing the
 * JSON again and rewrapping it like the file gives back the same text, so the codec can restore byte for byte.
 */
function decoded(
	text: string,
): { bytes: Uint8Array; reproducible: boolean } | null {
	const match = COMPRESSED_SCENE.exec(text);
	const [whole, heading = "", body = ""] = match ?? [];
	const json = match && unpack(body);
	if (!match || !whole || !json) return null;
	const [line = "", gap = ""] =
		/^([^\r\n]*)(\r?\n(?:\r?\n)?)?/.exec(body)?.slice(1) ?? [];
	const rewrapped = gap
		? compressToBase64(json).replace(
				new RegExp(`(.{${line.length}})`, "g"),
				`$1${gap}`,
			)
		: compressToBase64(json);
	const start = match.index + heading.length;
	const plain = `${text.slice(0, start)}\`\`\`json\n${json}\n\`\`\`${text.slice(match.index + whole.length)}`;
	return {
		bytes: new TextEncoder().encode(plain),
		reproducible: rewrapped === body,
	};
}

function kindOf(path: string, text: string): string {
	if (text && isDrawing(text))
		return COMPRESSED_SCENE.test(text)
			? "drawing (LZString)"
			: "drawing (JSON)";
	if (path.endsWith(".md")) return "note";
	if (path.endsWith(".canvas")) return "canvas";
	if (path.endsWith(".pdf")) return "pdf";
	return text ? "other text" : "binary";
}

function groupOf(
	groups: Map<string, Group>,
	kind: string,
	size: number,
): Group {
	const bucket = BUCKETS.find(([below]) => size < below)?.[1] ?? ">16M";
	const id = `${kind} ${bucket}`;
	const group = groups.get(id) ?? {
		kind,
		bucket,
		pairs: 0,
		today: 0,
		whole: 0,
		schemes: {},
	};
	groups.set(id, group);
	return group;
}

/** A damaged scene measures as plain bytes instead of stopping the run. */
function unpack(body: string): string | null {
	try {
		return decompressFromBase64(body.replace(/\s/g, ""));
	} catch {
		return null;
	}
}

function hoursOf(activity: Activity): [number, number][] {
	return Object.entries(activity).map(([hour, [pushes]]) => [
		Number(hour) * 3_600_000,
		pushes,
	]);
}

/** Pushes on each local day that had any. */
function perDay(pushes: readonly [number, number][]): number[] {
	const days = new Map<string, number>();
	for (const [time, count] of pushes) {
		const day = new Date(time).toDateString();
		days.set(day, (days.get(day) ?? 0) + count);
	}
	return [...days.values()].filter((count) => count > 0);
}

function sizes(min: number, avg: number, max: number): ChunkParams {
	return { min: min * KB, avg: avg * KB, max: max * KB };
}
