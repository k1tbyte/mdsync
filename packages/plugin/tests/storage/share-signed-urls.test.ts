import { SIGN_BATCH_MAX } from "@obsync/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareSignedUrls } from "@/storage/adapters/share-signed-urls";

const keysOf = (count: number) =>
	Array.from({ length: count }, (_, index) => `objects/k${index}`);
const urlOf = (key: string) => `https://s3.example/${key}?sig`;

function readUrls(sign?: (keys: string[]) => Promise<string[]>) {
	const batches: string[][] = [];
	const reads = new ShareSignedUrls((keys) => {
		batches.push(keys);
		return sign ? sign(keys) : Promise.resolve(keys.map(urlOf));
	});
	return { reads, batches };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("read URLs signed a batch at a time", () => {
	it("signs nothing until a hinted key is asked for", () => {
		const { reads, batches } = readUrls();

		reads.expect(keysOf(100));

		expect(batches).toEqual([]);
	});

	it("signs the hinted keys in order, a full batch at a time", async () => {
		const keys = keysOf(SIGN_BATCH_MAX * 2);
		const { reads, batches } = readUrls();
		reads.expect(keys);

		const taken = await Promise.all(keys.map((key) => reads.take(key)));

		expect(batches).toEqual([
			keys.slice(0, SIGN_BATCH_MAX),
			keys.slice(SIGN_BATCH_MAX),
		]);
		expect(taken).toEqual(keys.map(urlOf));
	});

	it("has parallel callers join one batch", async () => {
		const keys = keysOf(10);
		const { reads, batches } = readUrls();
		reads.expect(keys);

		await Promise.all(keys.slice(0, 4).map((key) => reads.take(key)));

		expect(batches).toEqual([keys]);
	});

	it("makes the next batch only when its first key is asked for", async () => {
		const keys = keysOf(SIGN_BATCH_MAX + 1);
		const { reads, batches } = readUrls();
		reads.expect(keys);

		await reads.take("objects/k0");
		expect(batches).toHaveLength(1);

		await reads.take(`objects/k${SIGN_BATCH_MAX}`);
		expect(batches).toEqual([keys.slice(0, SIGN_BATCH_MAX), [keys.at(-1)]]);
	});

	it("hands each URL out once, so a retry signs alone", async () => {
		const { reads, batches } = readUrls();
		reads.expect(keysOf(2));

		expect(await reads.take("objects/k0")).toBe(urlOf("objects/k0"));
		expect(await reads.take("objects/k0")).toBeNull();
		expect(batches).toHaveLength(1);
	});

	it("sends a key nobody hinted to a single sign", async () => {
		const { reads, batches } = readUrls();
		reads.expect(keysOf(2));

		expect(await reads.take("objects/other")).toBeNull();
		expect(batches).toEqual([]);
	});

	it("replaces an earlier hint", async () => {
		const { reads, batches } = readUrls();
		reads.expect(["objects/a", "objects/b"]);
		await reads.take("objects/a");

		reads.expect(["objects/c"]);

		expect(await reads.take("objects/b")).toBeNull();
		expect(await reads.take("objects/c")).toBe(urlOf("objects/c"));
		expect(batches).toEqual([["objects/a", "objects/b"], ["objects/c"]]);
	});

	it("answers null for every key of a batch that failed, and leaves the rest to single signs", async () => {
		const { reads, batches } = readUrls(() =>
			Promise.reject(new Error("relay down")),
		);
		const keys = keysOf(SIGN_BATCH_MAX + 1);
		reads.expect(keys);

		const first = await Promise.all(
			keys.slice(0, SIGN_BATCH_MAX).map((key) => reads.take(key)),
		);
		const last = await reads.take(keys.at(-1) as string);

		expect(first.every((url) => url === null)).toBe(true);
		expect(last).toBeNull();
		expect(batches).toHaveLength(1);
	});

	it("answers null when the batch returns fewer URLs than keys", async () => {
		const { reads } = readUrls(() => Promise.resolve([]));
		reads.expect(["objects/a"]);

		expect(await reads.take("objects/a")).toBeNull();
	});

	it("does not hand out a URL the relay may have let expire", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { reads } = readUrls();
		reads.expect(["objects/a", "objects/b"]);
		expect(await reads.take("objects/a")).toBe(urlOf("objects/a"));

		vi.advanceTimersByTime(60_000);

		expect(await reads.take("objects/b")).toBeNull();
	});
});

describe("a pull that skips hinted keys", () => {
	it("still batches from the key it asks for", async () => {
		const keys = keysOf(SIGN_BATCH_MAX * 2 + 10);
		const { reads, batches } = readUrls();
		reads.expect(keys);

		const skipped = SIGN_BATCH_MAX + 5;
		const url = await reads.take(keys[skipped] ?? "");

		expect(url).toBe(urlOf(keys[skipped] ?? ""));
		expect(batches[0]?.[0]).toBe(keys[skipped]);
		expect(batches[0]).toHaveLength(SIGN_BATCH_MAX);
	});

	it("stops batching after a batch failed, until the next hint", async () => {
		const keys = keysOf(SIGN_BATCH_MAX * 3);
		let answer: string[] | Error = new Error("relay too old");
		const { reads, batches } = readUrls(() =>
			answer instanceof Error
				? Promise.reject(answer)
				: Promise.resolve(answer),
		);
		reads.expect(keys);

		expect(await reads.take(keys[0] ?? "")).toBeNull();
		expect(await reads.take(keys[SIGN_BATCH_MAX] ?? "")).toBeNull();
		expect(batches).toHaveLength(1);

		answer = keys.slice(0, SIGN_BATCH_MAX).map(urlOf);
		reads.expect(keys);
		expect(await reads.take(keys[0] ?? "")).toBe(urlOf(keys[0] ?? ""));
		expect(batches).toHaveLength(2);
	});
});
