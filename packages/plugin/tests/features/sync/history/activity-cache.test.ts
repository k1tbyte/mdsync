import { describe, expect, it } from "vitest";
import { ActivityCache } from "@/features/sync/history/activity-cache";

function cache(initial: unknown = null) {
	let stored = initial;
	return new ActivityCache({
		load: () => stored,
		save: (value) => {
			stored = value;
		},
	});
}

describe("ActivityCache", () => {
	it("recalls what it remembered for the same storage only", () => {
		const activity = cache();
		activity.remember("s3:a", { 100: [3, 2] }, 5);
		expect(activity.recall("s3:a")).toEqual({
			activity: { 100: [3, 2] },
			at: 5,
		});
		expect(activity.recall("s3:b")).toBeNull();
	});

	it("keeps a newer read over one begun before it", () => {
		const activity = cache();
		activity.remember("s3:a", { 100: [2, 1] }, 20);
		activity.remember("s3:a", { 100: [1, 1] }, 10);
		expect(activity.recall("s3:a")?.activity).toEqual({ 100: [2, 1] });
	});

	it("forgets until a read begun after it", () => {
		const activity = cache();
		activity.remember("s3:a", { 100: [2, 1] }, 5);
		activity.forget();
		expect(activity.recall("s3:a")).toBeNull();
		activity.remember("s3:a", { 100: [2, 1] }, 5);
		expect(activity.recall("s3:a")).toBeNull();
		activity.remember("s3:a", { 100: [1, 1] }, Date.now() + 1);
		expect(activity.recall("s3:a")?.activity).toEqual({ 100: [1, 1] });
	});

	it("recalls nothing from a malformed entry", () => {
		expect(cache("junk").recall("s3:a")).toBeNull();
		expect(cache({ storage: "s3:a", at: 1 }).recall("s3:a")).toBeNull();
	});
});
