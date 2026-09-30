import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RevokedGrants } from "../../src/hub/revoked";
import { grant } from "../helpers/hub";
import { memorySql } from "../helpers/memory-sql";

const MINUTE = 60_000;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000_000);
});

afterEach(() => vi.useRealTimers());

describe("revoked grants", () => {
	it("refuses a revoked token while KV may still admit it, and only that slot", () => {
		const revoked = new RevokedGrants(memorySql());
		const vault = grant("vault");
		const share = grant("share", "cut");
		revoked.add("cut");

		vi.advanceTimersByTime(2 * MINUTE);

		expect(revoked.refuse([vault, share, null])).toEqual([vault, null, null]);
	});

	it("forgets a revocation once no stale read can outlive it", () => {
		const sql = memorySql();
		new RevokedGrants(sql).add("cut");

		vi.advanceTimersByTime(10 * MINUTE);
		const share = grant("share", "cut");

		expect(new RevokedGrants(sql).refuse([share])).toEqual([share]);
		new RevokedGrants(sql).add("other");
		expect(sql.exec("SELECT fingerprint FROM revoked").toArray()).toEqual([
			{ fingerprint: "other" },
		]);
	});

	it("refuses every grant of a closed channel for good, and no other", () => {
		const sql = memorySql();
		new RevokedGrants(sql).closeChannel("share");
		const vault = grant("vault");
		const owner = grant("share", "owner-token");
		const guest = grant("share", "guest-token", "p1");

		vi.advanceTimersByTime(30 * 24 * 60 * MINUTE);

		expect(new RevokedGrants(sql).refuse([vault, owner, guest])).toEqual([
			vault,
			null,
			null,
		]);
	});
});
