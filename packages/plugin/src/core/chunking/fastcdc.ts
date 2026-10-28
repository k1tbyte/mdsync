/** Chunk sizes in bytes: no chunk below `min` (but the last) or above `max`, `avg` a power of two. */
export interface ChunkParams {
	min: number;
	avg: number;
	max: number;
}

/** Bits the cut masks move off the average: FastCDC's normalization level 2. */
const NORMALIZATION = 2;

/**
 * Where FastCDC cuts `bytes`: the end offset of every chunk, the last at `bytes.length`. An edit moves only
 * the cuts near it, so the chunks around it keep their content and dedup.
 */
export function chunkEnds(
	bytes: Uint8Array,
	params: ChunkParams,
	gear: Uint32Array,
): number[] {
	const bits = Math.log2(params.avg);
	// Top bits: a left-shifted gear hash mixes the last 32 bytes only there.
	const strict = topBits(bits + NORMALIZATION);
	const loose = topBits(bits - NORMALIZATION);
	const ends: number[] = [];
	let start = 0;
	while (start < bytes.length) {
		start = cutAfter(bytes, start, params, strict, loose, gear);
		ends.push(start);
	}
	return ends;
}

/** 256 words drawn from `seed`: the same seed cuts the same content at the same places. */
export function gearTable(seed: number): Uint32Array {
	const gear = new Uint32Array(256);
	let state = seed >>> 0;
	for (let index = 0; index < gear.length; index++) {
		// mulberry32
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		gear[index] = (t ^ (t >>> 14)) >>> 0;
	}
	return gear;
}

function cutAfter(
	bytes: Uint8Array,
	start: number,
	{ min, avg, max }: ChunkParams,
	strict: number,
	loose: number,
	gear: Uint32Array,
): number {
	const end = Math.min(start + max, bytes.length);
	if (end - start <= min) return end;
	const normal = Math.min(start + avg, end);
	let hash = 0;
	let at = start + min;
	// A harder mask before the average and an easier one after it keep sizes close to `avg`.
	for (; at < normal; at++) {
		hash = ((hash << 1) + (gear[bytes[at] as number] as number)) >>> 0;
		if ((hash & strict) === 0) return at + 1;
	}
	for (; at < end; at++) {
		hash = ((hash << 1) + (gear[bytes[at] as number] as number)) >>> 0;
		if ((hash & loose) === 0) return at + 1;
	}
	return end;
}

function topBits(count: number): number {
	return (0xffffffff << (32 - count)) >>> 0;
}
